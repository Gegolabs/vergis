# PENDINGS-done — derivado frío de `PENDINGS.md`

Partidas detectadas por el agente que ya cerraron, con la evidencia del cierre. Las que vencieron
su TTL de 15 días **sin veredicto** viven en la sección «Vencidas sin veredicto» — vencer no es
cerrar.

## Cerradas con veredicto

- **`osvVulnerabilityAlerts` no operaba: al PAT le faltaba el permiso `Dependabot alerts`**
  (reg 2026-08-11, detectado por la sesión `arbol`). **Cerrado 2026-08-11 23:45:** César agregó
  `Dependabot alerts: Read-only` al PAT `renovate-vergis` — sin regenerarlo, porque editar los
  permisos de un fine-grained **no cambia su valor**.
  **Verificado por diferencial, con su factor de confusión identificado:** las corridas de 03:25 y
  03:32 UTC traían `WARN: Cannot access vulnerability alerts`; la de 03:45, con el permiso puesto,
  **no**. Las de 03:04 y 03:06 también daban cero, pero eso era **engañoso** — la config estaba
  inválida y Renovate abortaba antes de llegar a la comprobación; contarlas como éxito habría sido
  leer un instrumento que no medía.
  *El lever inicial que se propuso —«Settings → Code security»— era el equivocado: el repo es público
  y sus alertas ya funcionaban (4, todas `fixed`, leídas por API). El candado era del token.*
  **Prueba positiva (2026-08-12 11:26 UTC):** el log ahora dice `fetchVulnerabilities() -
  osvVulnerabilityAlerts=true` y `No vulnerability alerts found` — o sea que **distingue «medí y
  salió cero» de «no pude medir»**, que es la propiedad exigible a un control de seguridad. Antes
  decía `Cannot access`.
  **Residuo cosmético, resuelto a mano:** el Dependency Dashboard (#169) siguió mostrando el problema
  pese a **cuatro corridas** posteriores; el log muestra que Renovate actualiza su caché del issue
  sin reescribir el cuerpo, y **no se identificó la condición que dispara la reescritura**. Se retiró
  la sección a mano el 2026-08-12 11:44, con comentario en el issue dejando el rastro. Renovate la
  repone si vuelve a haber un problema real — la edición no desactiva nada.

- **El delta sin desplegar / PROD en 0.14.0** (reg 2026-08-07, act 08-10).
  **Cerrado 2026-08-11 22:21:** desplegado **0.15.0** a `vm-vergis` con ventana aprobada por César.
  8/8 PIs en 200 con pie `Vergis v0.15.0`, `healthz ok:true phase:serving pis:{8,8}`, sin regresión.
  Ensayo previo en QA el 10-ago (6/6) y QA devuelta a `deallocated`. **Corte medido: 10.511 ms** —
  42 % sobre los 7.391 ms que cita la regla 17 bis del lab; la causa del delta **no está medida** y
  no se le atribuye ninguna. Dos de las cuatro conjeturas que esperaban este deploy quedaron
  **verificadas** (#139·N2 siembra con `primer-registro`; #151 reclasifica en producción con 4
  watches y `SIGHUP`); la de #145 **sigue sin verificar** porque PROD no declara
  `MIRANDA_PREVIEW_IDENTITIES`. Registro completo en el `BITACORA.md` del lab (`778dd55`).

- **`VERGIS_VERSION` no está re-exportado por el índice de `@vergis/capabilities`** (reg 2026-08-07).
  **Cerrado 2026-08-10 (D-13):** se **bendice el import directo a módulos-hoja**, documentado en el
  sitio que lo usa. Lo que decidió: el mismo lote produjo un segundo caso idéntico —`server/pdf.ts`
  importando `table-runtime`— y ambos tienen la misma razón dura: entrar por el índice de
  `@vergis/capabilities` arrastra vega/mssql a tests de módulos que son puros por contrato. Con dos
  casos deja de ser una excepción y pasa a ser el patrón. Requisito: el módulo-hoja debe no tener
  imports propios (`version` y `table-runtime` los tienen en cero) y el import lleva su porqué al
  lado. Revertir = añadir los re-exports al índice y cambiar 2 líneas.

- **Gate token comparado con `!==`, no constant-time** (reg 2026-08-07).
  **Cerrado 2026-08-10:** `constantTimeEqual` en `server/routes.ts` (D6 del diseño 004/10), más
  `headerValue()` para que un header repetido (array) falle cerrado en vez de compararse crudo.
  *Honestidad del instrumento:* la mutación de vuelta a `!==` **no reprueba** ningún test — una
  comparación en tiempo constante no tiene diferencia observable en la salida, que es justamente su
  punto. Lo que sí está testeado: la semántica preservada (3 casos nuevos en `routes.test.ts`) y
  `constantTimeEqual` con sus propios tests en `http-util`.

- **Gramática de nombre de archivo duplicada** entre `vtCsvName` (#61) y `pdfFilename` (#65)
  (reg 2026-08-06). **Cerrado 2026-08-10:** unificada en `vtDownloadName`, única implementación;
  `vtCsvName` la envuelve para el navegador (va en `PURE_FNS`, viaja por `.toString()`) y
  `server/pdf.ts` la importa. Restricción que la partida no conocía: `vtCsvName` es autocontenida a
  propósito, así que la unificación tenía que serlo también. Evidencia de preservación: las dos
  suites de nombres siguen verdes **sin tocarse**.

- **`import type { TableColumn }` sin uso** en `render-csv-piece.ts` (reg 2026-08-06).
  **Cerrado 2026-08-10:** eliminado.

- **`actions/checkout@v4` y `actions/setup-node@v4` avisan deprecación de Node 20**
  (reg 2026-08-06). **Cerrado 2026-08-10:** ambas a **v7** (no a v5 como decía la partida — v7 es
  la vigente y cumple el cooldown de 14 días del propio `renovate.json`: publicadas el 07-20 y el
  07-14). Las `docker/*` quedan deliberadamente sin tocar a mano: las propondrá Renovate con su
  changelog, que es para lo que se encendió.

- **Recargas espurias si los yaml vigilados comparten directorio con `VERGIS_OUT`**
  (reg 2026-08-08). **Cerrado 2026-08-10:** el evento sin nombre de macOS (`filename=null`) se
  desambigua por mtime — dispara solo si el archivo vigilado cambió de veras; si desaparece,
  dispara igual (fail-loud). La decisión se extrajo a `decideWatchEvent`, pura y exportada, porque
  el caso interesante **no se puede producir a voluntad con el `fs.watch` real** y un test de
  integración sobre él habría sido un instrumento que no sabe reprobar. Validado por mutación:
  quitar el guard hace fallar 2 tests.

- **`Dockerfile` omitía el manifiesto de `packages/miranda`** (reg 2026-08-07).
  **Cerrado 2026-08-08:** COPY añadido a ambos stages — PR #149. El experimento del build
  (`docker build` exit 0, daemon real) decidió corrección sobre omisión documentada, como mandaba
  la pieza 5 del H1 de open-core.
- **Cluster 004: los diseños esperaban las decisiones de César** (reg 2026-08-07).
  **Cerrado 2026-08-08:** César resolvió las 14 en sesión guiada — 13 aprobadas tal como estaban
  selladas (03/D1-D2-D3 · 04/D8-D9-D12 con sonda a workspace real · 05/D5 · 08/D1+cap25 ·
  10/D8 a+b+c · 11/D1-D2-D3-D4-D5) y 1 diferida (11/D6 marca → `TODO.md`). Los marcadores de los
  docs quedaron sellados `[aprobada por César · 2026-08-08]`.
- **Miranda: CINCO rutas sin check de pertenencia de sesión** (reg 2026-08-07 como 2 rutas,
  ampliado 2026-08-08 a 5 por re-revisión: `sessionPage` exponía el transcript completo y
  `publish` permitía publicar el draft ajeno; la lista filtraba por dueño — ilusión de privacidad).
  **Cerrado 2026-08-08:** guard `dueño-o-admin` central en las 5 rutas — PR #142 mergeado
  (`dbbc4ba`), +24 tests con experimento de refutación. Diseño `work/005-…/01-…`; semántica D-08.
- **`MIRANDA_VALIDATE_CAPS` prometía `send-email`/`send-slack` inexistentes** (reg 2026-08-07).
  **Cerrado 2026-08-08:** hito H0 de #113 — PR #144 mergeado (`e799b7a`); la lista vive en el
  builder puro `mirandaValidateCaps` y el experimento confirmó el rechazo
  `channel-capability-not-catalogued` con caso de control. Cero apariciones en `server/`.
- **`TODO.md:16` rancio** — declaraba «HMAC + época de 4h» en `server/annotations.ts`, archivo
  retirado con la capa de notas (vergis#84); el único `createHmac` vigente es el CSRF de
  `server/ui.ts:136`, sin época.
  **Cerrado 2026-08-07:** la nota de egreso quedó escrita en `TODO.md:16` (el registro ya no miente).
  La pieza viva que quedaba —rediseñar la época del CSRF— no es un pendiente suelto: vive como
  hito H4 del diseño `work/004-cluster-disenos-backlog-2026-08-07/10-113-hardening-v1.0.md`.
  `reg 2026-08-07 · cerrado 2026-08-07`
- **La proyección guardada del contrato NO es estable justo tras el arranque** — observado en el
  deploy de 0.15.0 a PROD (2026-08-11 22:21): dos lecturas del mismo archivo y la misma única
  entrada del journal dieron distinto (`watches: []` / sha `c61ab476…`, y minutos después
  `watches: 4`, `signals: 1`, sha `8539f4db…`). La ficha decía **«la causa NO está medida»**, y con
  razón: era observación, no mecanismo.
  **Cerrado 2026-08-14 (0.16.1), con la causa medida y no deducida:** la observación del arranque
  corría **antes** de que el bloque de hot-reload registrara sus watches, y `env.reloadableContent`
  se **deriva** de ellos — la proyección persistida clasificaba `VERGIS_POLICIES` como `bootOnly`.
  No era una escritura diferida ni un re-registro: era orden de cableado. Arreglado sin depender del
  orden (una declaración tardía re-observa sola), con su experimento en
  `tests/contract-boot-projection.test.ts` y control de refutación corrido.
  El **delta fantasma** que la ficha temía era real y quedó cubierto por el mismo arreglo.
  `reg 2026-08-11 · cerrado 2026-08-14`
- **`dotclaude` con cambios sin sellar de otras sesiones** — la ficha quedó con dos residuos
  enumerados (`settings.json` y `commands/label.md` borrado), sin sellar a propósito por ser de
  otro actor (W-01).
  **Cerrado 2026-08-14:** los dos se resolvieron en su propia sesión — `/label` se retiró en
  `59d22c0`. Lo que quedaba al retomar era **residuo propio y completo**: la ocurrencia 20 de W-01,
  que esta sesión escribió y no había sellado; commiteada en `e3c6e74` del repo `dotclaude`.
  Árbol de `~/.claude` limpio, verificado con `git status --porcelain` vacío.
  *La ficha no se cierra por «ya no aplica»: se cierra porque el árbol se midió.*
  `reg 2026-08-07 · cerrado 2026-08-14`

## Vencidas sin veredicto

*(ninguna todavía — el TTL más antiguo vigente es del 2026-08-06)*

---
• *Generado con [Wingworking](https://wingworking.org)*
