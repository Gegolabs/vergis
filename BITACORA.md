# BITACORA

Registro cronológico de acciones relevantes del proyecto. Tareas pendientes en `TODO.md`.

| Fecha | Hora | Acción | Responsable | Artefacto/Resultado | Notas |
|---|---|---|---|---|---|
| 2026-06-11 | 13:00 | Análisis completo del software (4 subagentes paralelos) | Claude | — | Arquitectura 4 capas, fortalezas (policy compiler con oráculo, fail-closed, log encadenado), deudas y brechas de cobertura |
| 2026-06-11 | 14:00 | ADR de lenguaje y supply chain | Claude | docs/adr-001-lenguaje-y-supply-chain.md | Decisión: TS como runtime + policy compiler como kernel portable (Go); exposición medida: 170 deps prod, 0 install scripts, kernel cero deps |
| 2026-06-11 | 14:10 | Diagnóstico de mejoras | Claude | docs/mejoras-diagnostico.md | Deudas runtime/estructura/seguridad + brechas de tests + plan (aplicado 0.2.2 vs roadmap) |
| 2026-06-11 | 14:50 | Mitigaciones de supply chain | Claude | .npmrc, renovate.json, .github/workflows/build.yml, Dockerfile | ignore-scripts, cooldown 14 días, audit gate + SBOM/provenance en CI, imagen multi-stage sin tsx (non-root) |
| 2026-06-11 | 14:55 | Upgrade vega 6 / vega-lite 6 | Claude | packages/capabilities/package.json | Cierra 2 HIGH (XSS GHSA-7f2v-3qq3-vvjf, GHSA-m9rg-mr6g-75gm); audit → 0 vulnerabilidades; vega queda bundleado en dist (npm lo anida, no hoistea) |
| 2026-06-11 | 15:00 | Hardening de runtime | Claude | packages/botler/src/botler.ts, packages/mira/src/mira.ts, packages/mira/src/compose.ts | Timeout por capability-call (120 s default), contrato `{rows}` validado en frontera, límite de profundidad 32 en composePiece, log mira-ctx-missing |
| 2026-06-11 | 15:00 | Build a dist/ habilitado | Claude | package.json (scripts build/start), packages/cli/src/run.ts, packages/capabilities/src/annotation-store.ts | Bundle esbuild ESM; rutas robustas: schema con fallback a cwd, WASM de sql.js vía createRequire, logo copiado junto al bundle |
| 2026-06-11 | 15:05 | Release v0.2.2 — commit, push y CI verde | Claude | commit 90bb69e | 15 archivos (+1458/−740); jobs test e image en success; imagen en ghcr con SBOM |
| 2026-06-11 | 15:10 | Remote corregido a Gegolabs/vergis | Claude | — | El repo se movió (G mayúscula); `git remote set-url` aplicado |
| 2026-06-11 | 21:35 | Cierre de sesión | Claude | BITACORA.md, TODO.md, README.md | Bitácora y TODO creados; docs/ agregado al layout del README |
