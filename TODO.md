# TODO

Pendientes del proyecto. Registro cronológico en `BITACORA.md`.

> **El plan DETALLADO de lo pendiente (para ejecutar la próxima sesión) vive en `NEXT.md`** (raíz).
> El registro de lo IMPLEMENTADO en la sesión 2026-07-07 (32 archivos de producción, +impacto) está en
> `work/001-cluster-analisis-codigo-2026-07/07-registro-implementacion.md`; el plan maestro con todos
> los hallazgos en `work/001-cluster-analisis-codigo-2026-07/00-consolidado.md`.

## Roadmap técnico

Detalle y justificación en `docs/mejoras-diagnostico.md`:

- [x] Refactor de los tres monolitos — **HECHO**: `serve-rls.ts` (7 módulos, sesión 07-07; falta solo el wrap literal `createApp()`, ver NEXT.md · Ola 3·A, aceptado como culminación); `render-html-piece.ts` 965→370 LOC en 6 módulos y `mira.ts` 669→378 LOC en 5 módulos (sesión 07-08, ver NEXT.md · Ola 3·B). Todo behavior-preserving (512 tests)
- [x] HMAC criptográfico en el gateo de anotaciones — **HECHO** (`server/annotations.ts`, HMAC + época de 4h, con tests adversariales · A15)
- [ ] Aislamiento del render Vega en subproceso sin red ni filesystem (defensa en profundidad)
- [x] Caché de discovery de specs — **HECHO** (memoizado + invalidado on-change en `server/discovery.ts` vía `createCachedScanner`)
- [ ] Migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/` (declarado en README)
- [ ] Port del kernel `@vergis/policy` a Go — solo cuando exista driver de negocio (Custos standalone, embedding, librería); ver `docs/adr-001-lenguaje-y-supply-chain.md`

### Pendientes de sesión 2026-06-11

- [ ] **Habilitar la app de Renovate** en el repo/org Gegolabs — `renovate.json` no opera sin la app instalada en GitHub (acción de admin GitHub, humano)
- [x] **Redesplegar la VM** — **HECHO 2026-07-13**: PROD corre 0.6.0 (tren 0.4.0→0.5.0→0.6.0 en un día, cada release ensayado en el QA `vm-vergis-qa` antes de PROD); verificación estándar 6/6 PIs
- [x] **Verificar render de charts con vega 6 en un PI real** — **HECHO 2026-07-13**: los 6 PIs (incl. dashboards con charts) rinden 200 con contenido en PROD 0.6.0
