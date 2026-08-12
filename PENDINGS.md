# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

## Operación / despliegue

- **Dos conjeturas del 0.15.0 SIGUEN sin verificar, y el deploy no las tocó** — de las cuatro que
  esperaban producción, el despliegue del 2026-08-11 saldó dos (#139·N2 siembra ✓, #151 reclasifica ✓)
  y **las otras dos no, porque no dependían del deploy sino de condiciones que PROD no tiene**:
  (a) **el eslabón `serve-rls → runSpec` con identidad del roster** (#145) — PROD no declara
  `MIRANDA_PREVIEW_IDENTITIES`, así que la preview impersonada contra motor vivo no se ejercitó;
  poblar el roster es decisión de instancia; (b) **la entrega HTTP real por un sink recargado**
  (#151) — el mecanismo está demostrado por test, pero la línea del fan-out en producción sigue
  siendo inspección, no medición. **Ninguna de las dos se vuelve verdadera por el hecho de que el
  deploy saliera bien.** `reg 2026-08-11`
- **La proyección guardada del contrato NO es estable justo tras el arranque** — medido en el deploy
  de 0.15.0 a PROD (2026-08-11 22:21). Dos lecturas del **mismo archivo y la misma única entrada**
  del journal dieron distinto: primero `watches: []`, `signals: []`, `projectionSha256 c61ab476…`;
  minutos después `watches: 4`, `signals: 1`, sha `8539f4db…`. **Importa porque N2 computa su delta
  diffeando proyecciones persistidas**: si el sha de un mismo arranque cambia, hay que saber cuál
  queda registrada — y una lectura temprana puede producir un delta fantasma en el deploy siguiente.
  **La causa NO está medida** (re-registro deliberado, escritura diferida, o una primera recarga que
  re-proyecta): es observación, no mecanismo. Casi se publica como «#151 no registra sus watches en
  producción», que era **falso**. `reg 2026-08-11`
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

- **Los PRs de Renovate nacen con el CI en rojo: su regeneración del lockfile pierde entradas** —
  medido en su primera corrida (2026-08-12): el `package-lock.json` de `renovate/npm-ajv-vulnerability`
  trae **156 referencias `@esbuild/` contra las 234 de `main`** (y 12 vs 16 de `openharmony`), así que
  `npm ci` —que exige correspondencia exacta árbol↔lock— aborta en 6-10 s con `Missing:
  @esbuild/…@0.28.2 from lock file`. Afecta a **todo** PR futuro de Renovate, no solo a estos dos.
  **La causa NO está medida**: que sea la versión de npm del entorno de Renovate, o su resolución de
  optional deps por plataforma, es hipótesis — el experimento barato que la decidiría es regenerar
  el lockfile de esa rama con el npm del repo y comparar el conteo. Parchear una rama a mano NO
  cierra esto: cerraría un PR y dejaría la causa viva. `reg 2026-08-12`

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
