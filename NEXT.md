# NEXT — Vergis

## Frente nuevo (2026-09-05): el Botler genérico y Daftar como segundo proto-Botlet — diseño refrendado, nada construido

**César refrendó íntegro el doc 013** (`work/013-cluster-botler-generico/01-diseno-rector-botler-generico-daftar-v1.0.md`): ocho bifurcaciones por el criterio de excelencia y siete hitos H0–H7 con gate. Hechos medidos que lo fundan: la clase `Botler` de `packages/botler` **no se instancia en el servidor** (importa solo tipos, `AppendOnlyLog`, `withResultCache`, `identityFromHeaders`); `discovery.ts` parsea solo Mira; el predicado de salud de `/healthz`, el `Caddyfile.reference`, `vergis-rollout` y el poller del RUNBOOK dicen `pis`. **Próximo paso: Fable escribe los briefs ejecutables de H0 (registro de proto-Botlets, cero cambio de conducta), H1 (`pis → lets` + `botler-rollout`, CHANGELOG «rompe») y H2 (store `evaluaciones`)**; los ejecutan realizadores Opus en worktrees, gates serializados, por rama + PR. El resto de este archivo describe el estado previo y sigue vigente.

---

**0.26.0 es la versión publicada** (tag `v0.26.0`, 2026-09-03, commit `d8f9a80`), verificada contra el registry (2 plataformas): facetas con orden natural y acotadas (#285, #286) y «Aplicar cadencia» que vigila los slots manuales (#279), sobre 0.25.1 (#282) y 0.25.0 (#280). Anteriormente 0.24.0 (`fad4b4c`) trajo Trae los **filtros de número** en columnas numéricas (#277/#278, decisión de César tras el caso de PI-01) sobre 0.23.1 (segunda mitad de #266). **Issue abierto hoy: #279** — «Aplicar cadencia» programa corridas también en slots de carga manual.

**La instancia A.R.B.O.L. corre 0.26.0 desde el 2026-09-03 (23:10Z)**, promovida por anillos sin corte (segunda promoción; previo 0.25.1). Antes: 0.23.0 desde el 2026-09-02 (noche) — desplegada por el frente arbol
con corte medido de 7.314 ms, smoke 25/25 y paridad `compose` en 0. **Subir a 0.24.0 no exige nada** (ni env ni base) y es un solo recreate con ventana — pendiente de César. El gap de versiones que este
archivo arrastraba (0.18.0 → …) **ya no existe**, y el aviso al operador dejó de tener destinatario:
el operador era esta misma casa.

**Todos los issues de producto están cerrados** (#279, #285 y #286 cerrados el 2026-09-03 con 0.26.0). Quedan abiertos a propósito **#110, #111, #113**
(paraguas de roadmap: no son defectos, y cerrarlos borraría el mapa) y **#169** (dashboard de Renovate).

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **PRs de Renovate #261, #260, #251, #201, #175** | Nadie, todavía | `renovate/stability-days` sigue en `pending` para los cinco (cooldown de 14 días, ADR-001). #175 y #201 tienen más de 14 días y el status no se re-emitió: **conjetura no medida** — tildar `rebase-branch` en #169 debería refrescarlo. Se mergean cuando el check pase, con CI verde |
| ~~Renombrar `CONTRIBUTING.draft.md` → `CONTRIBUTING.md`~~ **Publicado el 2026-09-03 por refrendo de César** («Confirmo … el renombre»). Quedan `CODE_OF_CONDUCT.md` y la confirmación del correo de seguridad | **César** | El acto de publicación ya ocurrió; el correo `security@gegolabs.com` sigue sin confirmar |
| **#265 · medir contra un gateway real** | Instancia, cuando llegue Foundry (1-2 semanas desde 2026-09-02) | El cable existe (`MIRANDA_API_BASE_URL`); lo medido es que llega al transporte. El primer request real es la medición |
| **`VERGIS_MASTER_DATA` fuera del hot-reload** (hallazgo vecino de #262) | Esta casa | Sin issue propio. Cambiar `entidades.yaml` exige reiniciar el nodo (corte). Abrir issue cuando alguien lo necesite en caliente |
| **`Publisher.count()` contra un warehouse real** y la **réplica inexistente** en un destino nuevo | Instancia | La página de `empresas_relacionadas` en A.R.B.O.L. es el primer caso real: mirarla es la medición |
| **E4 de #238** — ¿la aptitud vale toda la vida de la conexión? | Esta casa | Sin medir; por la vía del `GRANT` es viable y cabe en una ventana propia |
| **`format: date` sin rama propia en `vtFormat`** aunque `catalogo-elementos.md` lo documenta como formateador | Esta casa | Discrepancia doc↔código destapada por #264; la fila del catálogo lo dice con precisión |

## Lo que cambió el 2026-09-02 (custodia por mandato)

César entregó la custodia de este repo por mandato explícito («asume el rol del mantenedor… cierra todos
los issues de producto y déjalos publicados»). Con eso, las bifurcaciones que estaban «de César» las
decidió esta casa y quedaron en `DECISIONS.md` **D-59…D-64**, revocables:

- **#250 → salida (A)**: aviso en la nav conservando el 200 (verificado con captura).
- **#232 → cerrado sin la propiedad completa**: el intent no entra en `acquire()` (frontera de confianza).
- **#186 → cerrado**: sus dos criterios abiertos estaban cumplidos u obsoletos.
- **#266 → fatal vs degradable explícito** en `config.ts`; #265 en el mismo PR.
- **#262 → las cuatro piezas**, con «no se pudo leer» como única respuesta honesta a un conteo ilegible.
- **#264 → `docs/capacidades.md`** con cotejo derivado del schema y sin gate de CI sobre el CHANGELOG.

**Cuatro realizadores Opus construyeron #262, #266/#265, #250 y #264 en paralelo**, cada uno con brief
propio, worktree propio y contraste medido; la custodia verificó composición, rebaseó los CHANGELOG
(todos chocaban en «Sin publicar») y mergeó en orden. El corte siguió «Antes de cortar» al pie:
`corte:cotejo` **atrapó una brecha real** (#259 sin citar), `fab:proof` corrió antes del tag
(2 min 31 s, US$0,015, `Paused` al cerrar).

**Gotcha del CI, para no redescubrirlo:** `build.yml` no dispara en PRs cuya base no es `main`, y
tampoco arrancó en dos PRs recién abiertos hasta que un `update-branch`/push los despertó.

## Orden de lectura para retomar

`CLAUDE.md` (§El aterrizaje · §La custodia) → este archivo → `DECISIONS.md` (D-59…D-64) →
`CHANGELOG.md` §0.23.0 «Qué exige esta versión» (los cuatro no-medidos, y cuáles corroboró ya la instancia).

<!-- /ww:go (paso 6, en disco) · 2026-09-02 · HEAD 58cf988+ · custodia por mandato -->
