# NEXT — Vergis

**0.23.0 es la versión publicada** (tag `v0.23.0`, 2026-09-02, commit `58cf988`). Imagen **verificada
contra el registry**: 2 plataformas, `org.opencontainers.image.revision=58cf988`, `version=0.23.0`.

**La instancia A.R.B.O.L. corre 0.23.0 desde el 2026-09-02 (noche)** — desplegada por el frente arbol
con corte medido de 7.314 ms, smoke 25/25 y paridad `compose` en 0. El gap de versiones que este
archivo arrastraba (0.18.0 → …) **ya no existe**, y el aviso al operador dejó de tener destinatario:
el operador era esta misma casa.

**Todos los issues de producto están cerrados.** Quedan abiertos a propósito **#110, #111, #113**
(paraguas de roadmap: no son defectos, y cerrarlos borraría el mapa) y **#169** (dashboard de Renovate).

## Lo que espera, y de quién es

| Partida | ¿De quién? | Estado |
|---|---|---|
| **PRs de Renovate #261, #260, #251, #201, #175** | Nadie, todavía | `renovate/stability-days` sigue en `pending` para los cinco (cooldown de 14 días, ADR-001). #175 y #201 tienen más de 14 días y el status no se re-emitió: **conjetura no medida** — tildar `rebase-branch` en #169 debería refrescarlo. Se mergean cuando el check pase, con CI verde |
| **Renombrar `CONTRIBUTING.draft.md` → `CONTRIBUTING.md`** (+ `CODE_OF_CONDUCT.md` y correos) | **César** | #267 mergeó el contenido **sin renombrar, a propósito**: el renombre es el acto de publicación que hace obligar la cláusula de licencia a terceros — revisión suya o de un abogado |
| **#265 · medir contra un gateway real** | Instancia, cuando llegue Foundry (1-2 semanas desde 2026-09-02) | El cable existe (`MIRANDA_API_BASE_URL`); lo medido es que llega al transporte. El primer request real es la medición |
| **El residuo de #266**: el bloque de arranque de Miranda en `serve-rls.ts` (~2136: catálogo, roster, store) **sigue tumbando el nodo** si falla con el flag ON | Esta casa decide si abre issue | Al menos una fatalidad es deliberada (#110·1). Declarado en `FATAL_ENVS`. Condición de issue: un arranque tumbado por Miranda con algo que no sea la key ni el `baseUrl` |
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
