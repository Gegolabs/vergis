# Cluster · Análisis de código Vergis — julio 2026

**Propósito.** Radiografía completa del código de Vergis buscando todas las mejoras posibles (corrección, seguridad, robustez, estructura, rendimiento, tests, infra), materializada por frente en un artefacto dedicado, más un consolidado con el plan de acción priorizado.

**Método.** Barrido con subagentes en paralelo, un frente por subagente, en **dos corridas independientes en Opus 4.8** (el override a Fable 5 no fue honrado por el harness — ver nota de motores). Sirven como segunda opinión sobre el mismo motor: se materializó lo confirmado entre ambas. El frente **admin/multipart** quedó fuera del alcance automatizado (el *real-time cyber safeguard* lo corta en los tres motores disponibles) y se cubrió con **revisión manual** volcada a archivo — ver `01-admin-checklist.md`.

**Base.** Rama `feat/052-r3-features-dsl`, sobre v0.2.2 (~17.3k LOC TS). El repo ya pasó por 3 rondas de revisión (work/052 R1–R3); estos hallazgos son la cuarta pasada.

---

## Documentos del cluster

| NN | Frente | Ámbito | Estado |
|----|--------|--------|--------|
| 01 | Capa `server/` | serve-rls, hot-reload, admin, multipart, pi-config, sql-tables, nav, ui, catalog | serve-rls ✅ · admin → `01-admin-checklist.md` (manual) |
| 02 | Capabilities de datos | stores (ClickHouse/SQLite/DWH), gobierno, master-data, intake, AAD, freshness, authz | 2 corridas Opus ✅ |
| 03 | Capabilities de render | render-html-piece, render-csv, table-runtime, markdown, themes | 2 corridas Opus ✅ |
| 04 | Mira · Botler · CLI · Policy | DSL parse/validate, pipeline, compose, compilador de policies, result-cache, log | 2 corridas Opus ✅ |
| 05 | Infra y supply chain | Docker, docker-compose, CI, npm audit, tsconfig, renovate, scripts | 2 corridas Opus ✅ |
| 06 | Calidad de tests | ejecución de la suite, cobertura, huecos en superficies de seguridad | 2 corridas Opus ✅ |
| 00 | **Consolidado + plan de acción** | ranking severidad × esfuerzo, olas de ejecución | ✅ `00-consolidado.md` |

> **Nota de motores.** Se intentó una segunda corrida en Fable 5 (`model: "fable"`) pero el harness **no honró el override**: los subagentes volvieron a correr en Opus 4.8 (confirmado por el *safeguard de ciber de Opus* que cortó al agente de admin/multipart, igual que en la 1ª corrida). Las dos tandas son Opus; sirven como corridas independientes (estabilidad de hallazgos), no como contraste Fable vs Opus. El frente `server/`-admin no tiene informe automatizado por el gate.

---

## Notas operativas

- Cada frente lista hallazgos con **[SEV] · categoría · archivo:línea · descripción · mejora · esfuerzo (S/M/L)**.
- El consolidado (`00-`) es el artefacto de decisión: dedup entre frentes, prioriza y arma el plan.
- Diagnóstico previo (junio 2026): `docs/mejoras-diagnostico.md` — este cluster lo actualiza.

---

• *Generado con [Wingworking](https://wingworking.org)*
