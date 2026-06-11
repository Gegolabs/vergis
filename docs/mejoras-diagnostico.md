# Diagnóstico de Mejoras — Vergis

**Versión:** 1.0
**Fecha:** 2026-06-11
**Base:** v0.2.1 (~5.900 LOC TypeScript)

---

## Contexto

Este documento registra el diagnóstico de calidad del código de Vergis: deudas técnicas identificadas, brechas de cobertura de tests y el plan de tratamiento. El núcleo de gobierno de datos (policy compiler + RLS dual-engine + auditoría) tiene calidad de producción; las deudas se concentran en los bordes del walking skeleton.

Las fortalezas que este diagnóstico preserva — y que ninguna mejora debe degradar:

- **Compilador de policies con oráculo**: IR no-Turing-completo, evaluador de referencia, 2.100 property tests diferenciales entre motores.
- **Fail-closed sistemático**: default-deny, binding parametrizado, pooling-safe, sin ruta de servir sin RLS.
- **Auditoría criptográfica**: log JSONL hash-encadenado SHA256 con `verifyChain()`.
- **Suite 100 % hermética**: 156 tests / 398 asserts, sin red ni Docker, ~10 s.
- **Reproducibilidad**: mismo spec ⇒ HTML byte-idéntico.

## Deudas de runtime

| Deuda | Ubicación | Impacto | Tratamiento |
|---|---|---|---|
| Sin timeout en `capabilityCall()` | `botler/src/botler.ts` | Una Capability colgada cuelga la invocación completa | Timeout configurable con error estructurado |
| Sin contrato de output de Capability | `mira/src/mira.ts` (cast `as { rows?: ... }`) | Fallos crípticos en runtime si una Capability devuelve mal | Validación de shape en la frontera, con error accionable |
| Recursión sin límite en `composePiece()` | `mira/src/compose.ts` | Stack overflow con spec patológica | Límite de profundidad explícito |
| `ctx` ausente se bindea como `''` silencioso | `mira/src/mira.ts` (`applyCtx`) | Query con parámetro vacío sin diagnóstico | Log de advertencia en la invocación |

La memoización de datasets por invocación ya existe (`mira.ts`: un dataset recuperado como fuente de un control no se vuelve a consultar para la pieza); no es deuda.

## Deudas de estructura

| Deuda | Ubicación | Impacto | Tratamiento |
|---|---|---|---|
| Archivo monolítico de render (826 LOC) | `capabilities/src/render-html-piece.ts` | Mantenimiento y testabilidad | Refactor a módulos por elemento (kpi, table, chart, semáforo, gaveta) — roadmap |
| Pipeline en un solo método (377 LOC, 6 fases) | `mira/src/mira.ts` | Lectura y testeo por fase | Extraer fases a métodos privados — roadmap |
| Servidor multipropósito (474 LOC) | `server/serve-rls.ts` | Mezcla discovery, identidad, render, bootstrap | Factorización — roadmap |
| Hardcodes | timeouts SQL (30 s/60 s), cardinalidad de facetas (25), nombres de paleta | Configurabilidad | Promover a configuración cuando exista el caso de uso |
| Discovery re-escanea specs por request | `server/serve-rls.ts` | Costo aceptable hoy; no escala a miles de specs | Caché con invalidación — cuando el volumen lo pida |

## Deudas de seguridad operacional

| Deuda | Ubicación | Tratamiento |
|---|---|---|
| `tsx` compila al vuelo en producción | `Dockerfile` | Build multi-stage a `dist/` + `node dist/` con `--omit=dev --ignore-scripts` |
| Vulnerabilidades HIGH en vega/vega-lite (XSS, GHSA-7f2v-3qq3-vvjf y GHSA-m9rg-mr6g-75gm) | `capabilities` | Upgrade a vega 6 / vega-lite 6; exploitabilidad acotada (specs confiables, render server-side) pero está en el path del HTML servido |
| Sin gate de audit ni cooldown de updates | CI | `npm audit` en CI + Renovate con `minimumReleaseAge` |
| Anotaciones gateadas por token opaco, sin HMAC criptográfico en el store | `capabilities/src/annotation-store.ts` | Implementar verificación HMAC del token por fila — roadmap |

El análisis completo de supply chain y la decisión de lenguaje viven en [adr-001-lenguaje-y-supply-chain.md](adr-001-lenguaje-y-supply-chain.md).

## Brechas de cobertura de tests

Bien cubierto: RLS/policy (exhaustivo, property testing diferencial), multi-vista y drill-through, tabla interactiva, freshness, entity store, governance.

Sin cubrir:

- **Delivery channels** (email, S3, webhook): declarados en el DSL, mecanismo sin tests.
- **Formatos CSV/PDF**: el schema los menciona; solo HTML está implementado y testeado.
- **Scheduling** (`quality.refresh.mode: scheduled`): solo on-demand testeado.
- **Recovery flow del fallback agéntico**: el log se testea; el flujo de recuperación es un stub (`mark-for-regeneration`).
- **Performance y concurrencia**: sin tests de carga ni de race conditions.

Estas brechas corresponden a funcionalidad declarada pero no implementada en v0.x; los tests llegan con la implementación, no antes.

## Plan de tratamiento

**Aplicado en 0.2.2** — mejoras seguras, verificables con la suite hermética:

- Mitigaciones de supply chain: `.npmrc` con `ignore-scripts`, Renovate con cooldown, gate de audit en CI, Dockerfile multi-stage sin tsx.
- Upgrade vega/vega-lite a v6 (cierra los dos HIGH).
- Endurecimiento de runtime: timeout en `capabilityCall`, validación de contrato `{ rows: [] }` en la frontera de Mira, límite de profundidad en `composePiece`, log `mira-ctx-missing` para parámetros de contexto sin valor.

**Roadmap** — requieren diseño o un driver de negocio:

- Refactor de los tres monolitos (`render-html-piece`, `MiraBotlet.invoke`, `serve-rls`).
- HMAC criptográfico en anotaciones.
- Aislamiento del render Vega en subproceso sin red ni filesystem (defensa en profundidad).
- Virtualización de tabla para volúmenes grandes, i18n, accesibilidad, exportación CSV/PDF.
- Caché de discovery de specs.
