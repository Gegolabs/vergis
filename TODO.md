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
- [x] **E/S del render Vega — CERRADA 2026-08-13** (D-21), aunque **no** por el subproceso que esta
  línea pedía. El vector real es que Vega carga datos sola (`data.url`, red o `file://`) y los specs
  traen los datos ya resueltos: se cierra con un **gate declarativo** que rechaza el spec con `url`
  antes de Vega, más un **loader que niega** toda E/S como red de seguridad. Dos capas porque el
  loader **solo protege en silencio** — medido con servidor local contando hits: por defecto el fetch
  ocurre (`hits=1`), con el loader no (`hits=0`) pero Vega se traga el error y rinde un gráfico vacío.
  **Por qué NO el subproceso**: medido en Node v22.22.3 (el mayor de la imagen), el permission model
  **no cubre la red** — bloquea fs y `child_process`, y `net.connect` conecta igual. Entregaría media
  promesa y metería un pool de procesos en el camino caliente.
  **Residuo declarado**: un exploit que haga E/S sin pasar por el loader de Vega no lo detiene ninguna
  capa. El día que haya driver, la fs se cierra con el permission model y **la red se cierra en la red
  del contenedor**, no en Node.
- [ ] **Gates manuales del release 0.14.0** (requieren motor/canales vivos + deploy, ver CHANGELOG 0.14.0 y los PRs #123/#127/#129/#130/#131/#132/#133): contrato escritor `_logs/` del SJD, rate limits del poll de frescura, Slack real, relay SMTP, `docker build` del sidecar PDF + fidelidad visual, pausa real en el motor, contrato D8 del convertidor (antes de declarar `revert_delete`), y modos passwordless de #66
- [x] **#107 fase 2** — **HECHO 2026-08-09**: publicación de definiciones de jobs en el motor desde
  Vergis (cluster 006, H1-H5, PRs #152-#158). El issue lo cerró César el 2026-08-09
- [x] **Deploy 0.14.0 a la VM** — **HECHO 2026-08-06 20:33** (autorizado por César): pre-check #117 de los 13 YAML ✓, ensayo QA ✓, PROD healthz 8/8 + smoke 8 PIs + frontera externa ✓; rollbacks listos (`vergis-rollback:pre-0140`, `governance.bak-1786062563.tgz`). El reconcile de #105 corrigió un drift real en su primera vuelta (G-M1 parcial ✓)
- [x] Caché de discovery de specs — **HECHO** (memoizado + invalidado on-change en `server/discovery.ts` vía `createCachedScanner`)
- [x] ~~Migrar los specs normativos del canon a `docs/`~~ — **NO SE MIGRAN, decidido 2026-08-13**
  (D-22). La premisa se re-derivó contra el terreno y no se sostenía: no hay archivos-spec sueltos
  que mover — lo normativo vive dentro del **libro publicado** *AgencyDomains* (v1.0, agosto 2026,
  agencydomains.org), bajo **GNU FDL v1.3**. Y esa licencia **no mezcla con la AGPL de este repo**:
  copiar el texto acá volvería una parte del árbol no redistribuible bajo su propia licencia.
  Segundo motivo, el que dolería después: un spec con dos casas driftea, y la copia siempre pierde
  — es exactamente lo que pasó con la línea del port a Go.
  **Hecho en su lugar**: `docs/canon.md` (dónde vive el canon, qué edición, por qué se cita y no se
  copia, y qué gana cada lado ante desacuerdo) + la frase del README corregida, que declaraba la
  migración «pendiente».
- ~~Port del kernel `@vergis/policy` a Go~~ — **DADA DE BAJA de este archivo 2026-08-10** (mandato de
  César). No se descarta el port: se devuelve a su única casa. La decisión ya vivía en
  `docs/adr-001-lenguaje-y-supply-chain.md` §Decisión·2 y esta línea era un duplicado que envejeció
  peor que su fuente — ADR-002 reencuadró el driver «Custos standalone» y el TODO no se enteró.
  Disparadores vivos y su re-verificación: en el ADR-001. Informe de la baja:
  `work/007-informe-port-go-2026-08-10/01-informe-baja-port-go-v1.0.md`

- [ ] **Terreno Fabric propio del Producto, desconectado del cliente** — **DECIDIDO POR CÉSAR
  2026-08-14** («hay que tenerlo»), registrado en **#186**. El Producto no tiene dónde medir lo que
  toca Fabric, así que **#163 se publicó en 0.16.0 con su mecanismo central sin medir** y siete
  partidas de `PENDINGS.md` existen solo porque el único banco es el QA **del cliente**.
  **Se evaluó y se descartó** apoyarse en la plataforma de Grupo Hijuelas para copiar sus datos: un
  terreno que copia datos del cliente deja de ser propio, acopla el banco a su esquema y no quita la
  dependencia. **Datos sintéticos**, tenant propio, y el terreno se **recrea** en vez de respaldarse.
  **El costo dejó de ser el argumento**: capacidad F2 pay-as-you-go **pausada por defecto** —mismo
  modelo que la VM desasignada—, del orden de un dólar por sesión de medición. **Trial NO**: muere a
  los 60 días y se lleva el terreno. Las decisiones de gasto e infraestructura siguen siendo suyas.
  **Encogido el 2026-08-14 con el terreno T-SQL local** (`npm run lab:proof`, PR #190): la premisa
  —«no hay dónde medir lo que toca Fabric»— era **falsa para la semántica del lenguaje**, y ahí se
  midieron y corrigieron los tres defectos del plano de columna (#163) y se destrabó #164. **Sigue
  haciendo falta**, sin urgencia, para lo que solo Fabric contesta: **SKU**, permisos de un service
  principal concreto, **costo** de enforcement, plano de control, OneLake/`Files/`, jobs, contrato
  `_logs/` y correlación carga↔corrida. Criterio nuevo que conviene fijar cuando se levante: **el
  bootstrap del terreno Fabric debe levantar la MISMA forma que el arnés local**, para que la única
  diferencia entre los dos sea el motor.

### Decisiones y acciones de César (2026-08-08, ronda de decisiones del cluster 004)

- [x] **Marca «Vergis» (y eventualmente «Custos»/«Miranda»)** — **DECIDIDO POR CÉSAR 2026-08-13: no
  se registra nada.** Cierra la D6 de `004/11`, que estaba diferida desde el 2026-08-08. Es decisión
  suya, de las que el mandato no cubre (gasto y compromiso de Gegolabs ante un registro público) —
  ver D-19 en `DECISIONS.md`, que la dejó sin tocar por esa misma razón.
  **El riesgo asumido, dicho con todas sus letras**: en open-core el nombre es lo único que un fork
  no se lleva (`004/11` §marca), y la ausencia de registro es **irreversible si un tercero registra
  primero**. El estado registral nunca se verificó y ya no hace falta verificarlo.
  **Qué reabriría esto**: que aparezca un tercero usando el nombre, o que el corte open-core llegue
  a distribución comercial. Ese día el insumo sigue siendo el mismo (memo de disponibilidad + clases
  de Niza), y ya no será barato.
- [ ] **Revisión (suya o de abogado) del borrador de `CONTRIBUTING.md`** — la cláusula DCO +
  licencia de contribución (11/D5, aprobada) se redacta como borrador y NO se publica sin esta
  revisión. La ventana del dual licensing se cierra con el primer PR externo sin acuerdo.
  **Borrador REDACTADO 2026-08-10** en `CONTRIBUTING.draft.md` (D-18). El nombre no es cosmético:
  GitHub muestra `CONTRIBUTING.md` a todo el que abre un issue o PR, y ahí la cláusula empieza a
  obligar a terceros — **renombrarlo ES el acto de publicación**, y ése es tuyo. Dos cosas
  marcadas dentro del borrador esperan dato: la redacción legal de la cláusula y la dirección de
  contacto de seguridad (`security@gegolabs.com`, sin confirmar).

### Pendientes de sesión 2026-06-11

- [x] **Habilitar Renovate** — **RESUELTO 2026-08-10 por otra vía** (D-11): en vez de instalar la
  GitHub App (consentimiento OAuth del owner, no automatizable), corre **self-hosted** en el propio
  CI (`.github/workflows/renovate.yml`), usando el mismo `renovate.json` sin traducir nada.
  **COMPLETADO 2026-08-11**: César emitió el PAT fine-grained (`renovate-vergis`, owner Gegolabs,
  solo `Gegolabs/vergis`, expira **2027-08-12**) y lo guardó como secret `RENOVATE_TOKEN`. Tiene su
  Dependency Dashboard (#169) y **el cooldown de supply chain del ADR-001 está ACTIVO**.
  **CORREGIDO 2026-08-13 — esta ficha afirmaba dos cosas que ya no son ciertas:**
  (a) decía «Renovate corre verde», y **era verde sin hacer su trabajo**: un 403 al publicar commit
  status abortaba la corrida tras la PRIMERA rama de ~20, con el job en verde. Se resolvió agregando
  **`Commit statuses: Read and write`** al PAT — que por eso hoy tiene **6 permisos, no los 5** que
  esta ficha listaba. Efecto visible: el check `renovate/stability-days` ahora se publica en cada PR,
  o sea el cooldown pasó de invisible a evidencia.
  (b) decía que sus PRs «nacen con el CI en rojo». **Ya no**: la causa era la versión de npm —
  Renovate regeneraba con **npm 12**, que poda las optional deps— y quedó curada con
  `constraints.npm: "^10.9.8"` más el candado `allowedVersions: "<11"`. Verificado end-to-end: el
  PR #177 nació verde y se mergeó.
  ⏰ **El PAT vence el 2027-08-12** — ese día el workflow falla en rojo, que es el comportamiento
  buscado
- [x] **Redesplegar la VM** — **HECHO 2026-07-13**: PROD corre 0.6.0 (tren 0.4.0→0.5.0→0.6.0 en un día, cada release ensayado en el QA `vm-vergis-qa` antes de PROD); verificación estándar 6/6 PIs
- [x] **Verificar render de charts con vega 6 en un PI real** — **HECHO 2026-07-13**: los 6 PIs (incl. dashboards con charts) rinden 200 con contenido en PROD 0.6.0
