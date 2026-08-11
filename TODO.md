# TODO

Deuda protegida del proyecto: lo que César declaró o confirmó como pendiente (sin TTL). Lo que
detecta el agente vive en `PENDINGS.md` (TTL 15 días → `PENDINGS-done.md` §vencidas). Registro cronológico en
`BITACORA.md`; decisiones tomadas en nombre de César en `DECISIONS.md`.

> El registro de lo IMPLEMENTADO en la sesión 2026-07-07 (32 archivos de producción, +impacto) está en
> `work/001-cluster-analisis-codigo-2026-07/07-registro-implementacion.md`; el plan maestro con todos
> los hallazgos en `work/001-cluster-analisis-codigo-2026-07/00-consolidado.md`.

## Roadmap técnico

Detalle y justificación en `docs/mejoras-diagnostico.md`:

- [x] Refactor de los tres monolitos — **HECHO**: `serve-rls.ts` (7 módulos, sesión 07-07; falta solo el wrap literal `createApp()`, ver NEXT.md · Ola 3·A, aceptado como culminación); `render-html-piece.ts` 965→370 LOC en 6 módulos y `mira.ts` 669→378 LOC en 5 módulos (sesión 07-08, ver NEXT.md · Ola 3·B). Todo behavior-preserving (512 tests)
- [x] HMAC criptográfico en el gateo de anotaciones — **HECHO** (`server/annotations.ts`, HMAC + época de 4h, con tests adversariales · A15). *Nota 2026-08-07: ese archivo y su esquema fueron RETIRADOS con la capa de notas (vergis#84) — el mecanismo ya no existe en el árbol; el único HMAC vigente es el CSRF de `server/ui.ts`, sin época. La época se rediseña en `work/004-…/10-113-hardening` H4.*
- [ ] Aislamiento del render Vega en subproceso sin red ni filesystem (defensa en profundidad)
- [ ] **Gates manuales del release 0.14.0** (requieren motor/canales vivos + deploy, ver CHANGELOG 0.14.0 y los PRs #123/#127/#129/#130/#131/#132/#133): contrato escritor `_logs/` del SJD, rate limits del poll de frescura, Slack real, relay SMTP, `docker build` del sidecar PDF + fidelidad visual, pausa real en el motor, contrato D8 del convertidor (antes de declarar `revert_delete`), y modos passwordless de #66
- [x] **#107 fase 2** — **HECHO 2026-08-09**: publicación de definiciones de jobs en el motor desde
  Vergis (cluster 006, H1-H5, PRs #152-#158). El issue lo cerró César el 2026-08-09
- [x] **Deploy 0.14.0 a la VM** — **HECHO 2026-08-06 20:33** (autorizado por César): pre-check #117 de los 13 YAML ✓, ensayo QA ✓, PROD healthz 8/8 + smoke 8 PIs + frontera externa ✓; rollbacks listos (`vergis-rollback:pre-0140`, `governance.bak-1786062563.tgz`). El reconcile de #105 corrigió un drift real en su primera vuelta (G-M1 parcial ✓)
- [x] Caché de discovery de specs — **HECHO** (memoizado + invalidado on-change en `server/discovery.ts` vía `createCachedScanner`)
- [ ] Migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/` (declarado en README)
- ~~Port del kernel `@vergis/policy` a Go~~ — **DADA DE BAJA de este archivo 2026-08-10** (mandato de
  César). No se descarta el port: se devuelve a su única casa. La decisión ya vivía en
  `docs/adr-001-lenguaje-y-supply-chain.md` §Decisión·2 y esta línea era un duplicado que envejeció
  peor que su fuente — ADR-002 reencuadró el driver «Custos standalone» y el TODO no se enteró.
  Disparadores vivos y su re-verificación: en el ADR-001. Informe de la baja:
  `work/007-informe-port-go-2026-08-10/01-informe-baja-port-go-v1.0.md`

### Decisiones y acciones de César (2026-08-08, ronda de decisiones del cluster 004)

- [ ] **Marca «Vergis» (y eventualmente «Custos»/«Miranda»)** — D6 de `004/11` DIFERIDA por César:
  la decide después. El registro temprano es barato; la ausencia es irreversible si otro registra
  primero. Estado registral sin verificar. (Insumo disponible a pedido: memo de disponibilidad +
  clases de Niza.)
- [ ] **Revisión (suya o de abogado) del borrador de `CONTRIBUTING.md`** — la cláusula DCO +
  licencia de contribución (11/D5, aprobada) se redacta como borrador y NO se publica sin esta
  revisión. La ventana del dual licensing se cierra con el primer PR externo sin acuerdo.

### Pendientes de sesión 2026-06-11

- [x] **Habilitar Renovate** — **RESUELTO 2026-08-10 por otra vía** (D-11): en vez de instalar la
  GitHub App (consentimiento OAuth del owner, no automatizable), corre **self-hosted** en el propio
  CI (`.github/workflows/renovate.yml`), usando el mismo `renovate.json` sin traducir nada.
  **Falta un acto humano de un minuto**: crear el PAT y guardarlo como secret `RENOVATE_TOKEN`
  (Settings → Secrets and variables → Actions). Hasta entonces el workflow falla en rojo a
  propósito — el cooldown de supply chain del ADR-001 NO está activo y tiene que verse
- [x] **Redesplegar la VM** — **HECHO 2026-07-13**: PROD corre 0.6.0 (tren 0.4.0→0.5.0→0.6.0 en un día, cada release ensayado en el QA `vm-vergis-qa` antes de PROD); verificación estándar 6/6 PIs
- [x] **Verificar render de charts con vega 6 en un PI real** — **HECHO 2026-07-13**: los 6 PIs (incl. dashboards con charts) rinden 200 con contenido en PROD 0.6.0
