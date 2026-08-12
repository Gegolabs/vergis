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
  medido en su primera corrida (2026-08-11): el `package-lock.json` de `renovate/npm-ajv-vulnerability`
  trae **156 referencias `@esbuild/` contra las 234 de `main`** (y 12 vs 16 de `openharmony`), así que
  `npm ci` —que exige correspondencia exacta árbol↔lock— aborta en 6-10 s con `Missing:
  @esbuild/…@0.28.2 from lock file`. Afecta a **todo** PR futuro de Renovate, no solo a estos dos.
  **Experimento corrido (2026-08-11), con resultado parcial:** (1) regenerado el lockfile de esa
  rama en un worktree con el npm del repo (10.9.8) vuelve a **234**, con `ajv` en 8.20.0 y
  `found 0 vulnerabilities` ⇒ **el defecto no es del repo, es del lado de Renovate**; (2) su log en
  debug mostraba `extractedConstraints: {"node":">=22","npm":">=7"}` — infiere el mínimo del
  `lockfileVersion` y queda libre de elegir npm; (3) **se cerró el rango** (`engines.npm >=10` +
  `constraints.npm` explícito, commit `81423d8`) y se forzó el rebase de las dos ramas por la
  casilla `rebase-all-open-prs` del dashboard… **y el lockfile siguió en 156.**
  ⇒ **La hipótesis del constraint es INSUFICIENTE.** Medido bien: las dos ramas SÍ se regeneraron
  (`Branch updated`, HEADs nuevos, verificado por API contra el repo, no por refs locales) y el
  conteo siguió en 156. El fix se deja puesto (correcto e inocuo) pero **no resolvió**.
  **Segunda hipótesis, también REFUTADA** (2026-08-11, tarde en la noche): `binarySource=install`,
  para que Renovate instalara el npm del constraint en vez de usar el de su imagen. Medida sobre las
  ramas **recreadas** de `#171`/`#172` —que **sí** tocan `package-lock.json`, verificado con
  `compare`— siguieron dando **156** contra 234 del control. Se retiró del workflow para no dejar una
  variable sin justificación. ⚠️ En el camino casi se valida con `renovate/pin-dependencies` (234
  refs): esa rama **no toca el lockfile**, hereda el de `main` — instrumento que no mide lo que parece.
  **Ambas hipótesis muertas. La causa sigue sin identificar.** Lo que queda sin medir: qué npm usa
  Renovate — el `debug` no lo imprime, haría falta `trace`.
  **Impacto hoy: acotado.** Las dos CVEs se aplicaron a mano (PR #173, mergeado) con el lockfile
  regenerado por el npm del repo, así que no dependen de esto. Lo que sigue roto es que **todo PR
  futuro de Renovate nace con el CI en rojo** y hay que rehacerle el lockfile a mano para mergearlo.
  **Vía propuesta (2026-08-12) — COMPENSAR, no diagnosticar.** Perseguir la causa quemó dos
  hipótesis sin resultado; el reencuadre es que la pregunta útil no es «¿cuál es la causa?» sino
  «¿qué cuesta la fricción?». Y cuesta donde duele: si cada PR exige trabajo a mano, nadie mergea y
  **el cooldown de 14 días se vuelve decorativo** — peor, la falla aterriza en el camino de
  seguridad, donde un CVE que se saltó el cooldown como fue diseñado se queda en rojo esperando.
  **Propuesta: `postUpgradeTasks` corriendo `npm install --package-lock-only` tras cada
  actualización**, con el npm del repo — literalmente lo que hacemos a mano, automatizado. La
  palanca **existe y la controlamos por ser self-hosted**: `allowedCommands` es opción *global-only*
  del administrador del bot (antes `allowedPostUpgradeCommands`), y el administrador somos nosotros;
  como GitHub App no se podría. **Verificado que la opción existe** (docs de Renovate);
  **NO verificado en este montaje**. Criterio de éxito, declarado antes de medir: el lockfile del
  próximo PR de Renovate da **234**. Es compensación, no cura: la causa sigue sin identificar y si
  la divergencia produce algo más allá de las optional deps de esbuild, esto lo enmascara — aunque
  no es peor que el workaround manual, solo automático.
  **IMPLEMENTADO Y MEDIDO (2026-08-12)** — commits `3bae7a1` y `b884960`. Lo verificado con señal
  **positiva**, no con ausencia de error: (1) **`allowedCommands` SÍ abre la puerta en este montaje**
  — el log de la corrida `31596456516` muestra la opción parseada dentro del contenedor y el comando
  ejecutado con sus `spawnargs` exactos; eso era el supuesto grande y **queda cerrado**. (2) **El
  comando repara el lockfile**: medido DENTRO de la imagen real del bot
  (`ghcr.io/renovatebot/renovate:43` + `install-tool node 22.22.3` ⇒ npm 10.9.8), sobre el árbol
  exacto de `renovate/npm-ajv-vulnerability`: **156 → 234**, con el bump preservado (ajv 8.20.0).
  **Lo que la medición además ACOTA sobre la causa** (sin identificarla): **no es que npm pode las
  optional deps** — el MISMO comando en el MISMO entorno produce 234. Renovate regenera el lockfile
  por otra vía. Eso mata una tercera hipótesis antes de que costara una corrida.
  **Dos trampas que costaron una corrida roja y quedan escritas en `renovate.json`:** (a) la imagen
  del bot trae `node` pero **NO trae `npm`** — sin `installTools` el comando muere con
  `spawn npm ENOENT` y el `unhandledRejection` **TUMBA LA CORRIDA ENTERA**, o sea apaga el control de
  supply chain, no solo el arreglo (`install-tool npm` solo tampoco sirve: «parent tool not installed:
  node»); (b) **`installTools` es un OBJETO, no el array que dice la doc pública**, y su versión debe
  ir **exacta** — containerbase rechaza `^22.0.0` y `>=22` con «tool version not supported», **y el
  `renovate-config-validator` los acepta igual**. De ahí la lección transversal: **el validador
  verifica FORMA, no SEMÁNTICA** — pasar el gate no es prueba de que la corrida sobreviva.
  **El último eslabón NO está verificado y está BLOQUEADO**: falta ver a Renovate aplicar y commitear
  el lockfile bueno en una rama npm suya. No se pudo llegar — ver el pendiente del 403 de `statuses`,
  que aborta la corrida antes de alcanzar ninguna rama npm. `reg 2026-08-11 · act 2026-08-12`

- **🔥 El PAT de Renovate no puede escribir commit statuses, y eso ABORTA la corrida entera — con el
  job en VERDE** — descubierto el 2026-08-12 persiguiendo lo anterior. Evidencia dura, idéntica en
  tres corridas: `POST /repos/Gegolabs/vergis/statuses/<sha>` ⇒ **403 «Resource not accessible by
  personal access token»**; Renovate lo traduce a `repository-changed`, imprime *«Repository has
  changed during renovation - aborting»* y **corta**. Resultado medido: de ~19 ramas candidatas
  procesa **solo la primera** (`renovate/pin-dependencies`) y nunca llega a las npm.
  **NO es regresión de esta sesión, es PREEXISTENTE**: la corrida `31591828225` (11:26, `bc0402b`,
  antes de tocar nada) ya traía el mismo 403 y el mismo abort.
  **Por qué es más grave que su síntoma:** el workflow declara por escrito la doctrina fail-closed
  —«preferimos el rojo honesto; un control apagado tiene que verse, no degradarse en silencio»— y
  este caso **la viola**: el control corre a un quinceavo de su alcance y el job sale **verde**. Es
  un control inerte con cara de control vigente, exactamente lo que el workflow existe para evitar.
  **Causa probable, NO confirmada:** el `minimumReleaseAge` de 14 días publica un commit status de
  estabilidad, así que **sería el propio cooldown el que dispara el POST que el token no puede
  hacer**. Es conjetura: no está medida.
  **Mismo linaje que el hallazgo del 2026-08-11 («el candado de las alertas es del TOKEN, no del
  repo»): el permiso que falta no se ve en el repo, se ve en el PAT.**
  **Requiere a César** — el PAT fine-grained solo lo edita su dueño: agregar **`Commit statuses:
  Read and write`** en https://github.com/settings/personal-access-tokens (el workflow documenta
  Contents · Pull requests · Workflows · Issues · Metadata, y **falta Statuses**). Alternativa sin
  tocar el PAT, que es decisión suya y no se tomó: desactivar el check por `statusCheckNames`,
  al costo de perder el status visible del cooldown. `reg 2026-08-12`

- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`

## Práctica / entorno (fuera del árbol de Vergis)

- **`~/evals-finaliza/` no está bajo control de versiones** — ahí viven la clave, los 3 reportes
  del A/B, los 2 veredictos y el reporte de bug de esta sesión. Perderlos borraría la evidencia del
  experimento. Decidir: `git init` local (sin remoto basta) o declarar en el arnés que es scratch
  desechable. `reg 2026-08-07`
- **`dotclaude` con cambios sin sellar de otras sesiones** — *revisado el 2026-08-10 (diff SANO) y
  **encogido el 2026-08-11***: las sesiones dueñas ya sellaron lo suyo — `WATCH.md`/`WATCH-logs.md`
  están commiteados (con **la ocurrencia 8 de W-01** que registró esta sesión; el contador va en
  **12**, las 9-12 son de otras). **Quedan solo dos**: `settings.json` (hook `Stop` a
  `hooks/sync-cmux-title.sh` —el script existe, ejecutable, del 08-08— y la clave `model` reubicada
  sin cambiar de valor, que es el `/model` reescribiendo el archivo) y `commands/label.md` borrado.
  **NO se sellan a propósito**: no son de esta sesión, y commitear el estado parcial de otro actor
  es el fenómeno W-01 que el propio diff registra. `reg 2026-08-07 · act 2026-08-11`
