# Plan · facetas con orden natural y acotadas (#285, #286) · cadencia que no programa slots manuales (#279)

| | |
|---|---|
| **Objetivo** | Cerrar los tres issues de producto abiertos con demandante en la instancia A.R.B.O.L.: #285, #286 (PI-30 sobre PI-15) y #279 (PI-01, Finanzas) |
| **Origen** | Mandato autónomo de César 2026-09-03 («cerrar todos los pasivos, incluso los de Vergis») bajo la custodia de `vergis` (DECISIONS D-59…) |
| **Ejecutor** | Dos realizadores Opus en worktrees propios: **A** (#285 + #286, un PR) y **B** (#279, un PR). La custodia (Fable) integra, corta la versión y avisa |
| **Versión que los publica** | `0.26.0` (capacidades nuevas del runtime y del reconciliador) |

## Contexto para el realizador (arranque en frío)

- Repo `Gegolabs/vergis`, TypeScript, monorepo `packages/*` + `server/`. Gates locales obligatorios antes del PR: `npm run typecheck` · `npm test` (vitest) · `npm run build`. `vitest` no typechequea: correr el typecheck **después** de escribir tests. En un worktree nuevo, `npm ci` primero.
- Convención de commits: `area(subarea): resultado` en español; el PR se titula igual y su cuerpo dice qué se mide y qué no. Cada PR agrega su bloque al `CHANGELOG.md` bajo `## Sin publicar` (crear la sección si no existe, arriba de la última versión). Los CHANGELOG de PRs paralelos chocan en «Sin publicar»: no importa, la custodia lo resuelve al integrar.
- Estilo de test: `tests/table-num-filters.test.ts` (funciones puras exportadas desde `@vergis/capabilities`) y `tests/filtros-visibles-facetas.test.ts` (render + `TABLE_RUNTIME_SOURCE`). Cada test nuevo debe **fallar contra `main`** (control negativo): decirlo en el PR con la corrida.
- Prohibido: tocar specs de instancia, vocabulario nuevo del DSL, CSS por-PI, reescribir el CHANGELOG histórico, `npm audit fix`, mergear (la custodia mergea).
- Norma 7 (Constitución): un mecanismo no se publica sin la corrida que lo habría refutado. El PR enumera esas corridas.

---

## Realizador A · #285 + #286 — facetas de `table` (`packages/capabilities/src/table-runtime.ts`)

### Dónde está el problema (medido en 0.25.1)

- `buildPop` (`:884-899`, dentro de `DOM_GLUE`, viaja al browser como string): `vals = vtDistinct(rows, field).slice().sort((a,b) => vtNorm(a).localeCompare(vtNorm(b)))` y `counts = vtCounts(rows, field)` — **sobre `rows` completo**, y el popover se construye **una sola vez** (`:906`, `if(!pop.innerHTML) buildPop(...)`).
- `vtGroup` (`:434-452`, función pura exportada): ordena las claves de grupo con el mismo `localeCompare`.
- Efecto en PI-15: faceta `Mes` = `Abril, Agosto, Diciembre, Enero…`; faceta `Week` = `W1, W10, W11, …, W2…`; con `Mes = Marzo` activo, `Week` lista las 52 semanas.

### Hito A.1 · orden natural (#285)

Nueva función **pura** exportada `vtNaturalCompare(a: unknown, b: unknown): number` (o `vtSortValues(vals: string[]): string[]`), en `table-runtime.ts`, agregada a `PURE_FNS` para que viaje al browser. Regla, decidida por el **conjunto** de valores no vacíos de la columna (misma filosofía que `vtIsNumericCol`), no valor a valor:

1. Todos numéricos (`vtIsNumericCol`-like sobre los distintos) → numérico ascendente.
2. Todos fecha ISO (`YYYY-MM-DD…`) → lexicográfico (= cronológico).
3. Todos calzan `^\s*([A-Za-z]{1,3})\s*-?\s*(\d+)\s*$` (prefijo alfabético corto + número: `W2`, `W10`, `S3`, `Q1`) **con el mismo prefijo** (insensible a mayúsculas) → por número.
4. Todos son **nombres de mes** en español o inglés, completos o abreviados a 3 letras, insensibles a mayúsculas y acentos (`vtNorm` ya normaliza acentos: revisar) → orden calendario. Tabla de nombres dentro de la función (autocontenida: viaja por `.toString()`, **cero closures ni imports**).
5. Si no, `vtNorm(a).localeCompare(vtNorm(b))` como hoy.

El valor vacío `''` va **siempre al final**. Aplicarla en `buildPop` (lista de la faceta) y en `vtGroup` (claves de grupo). `vtGroupTree` hereda.

Tests (`tests/table-natural-order.test.ts`): los cinco casos + vacíos + mezcla que NO califica (p. ej. `['W1','Marzo']` → alfabético) + `vtGroup` con meses. Control negativo: contra `main`, el test de meses devuelve `Abril` primero.

### Hito A.2 · opciones acotadas por los demás filtros (#286)

Regla del autofiltro de Excel, como convención (sin DSL):

- Al abrir la faceta de `X`, lista y conteos se calculan sobre `vtApply(rows, stateSin(X))`, donde `stateSin(X)` es el estado vigente **sin la faceta de `X`** (las demás facetas, `numFilters`, `dateFilters`, `globalSearch` y `colSearch` siguen aplicando). Nueva función pura exportada `vtFacetOptions(rows, state, field): { value: string; count: number }[]` que hace exactamente eso (usa `vtApply` con una copia del estado sin `facets[field]`), ordenada con A.1. Agregarla a `PURE_FNS`.
- Los valores **ya seleccionados** en `X` que no tengan filas bajo el resto de filtros se conservan en la lista, marcados, con conteo `0` (para poder quitarlos).
- `buildPop` se **reconstruye al abrir** si el estado cambió desde la última construcción: guardar en el popover un sello (`data-built-for = JSON.stringify(snapshotSinX)`) y comparar; si difiere, reconstruir. Conservar el texto del buscador del popover no es requisito.
- El comportamiento de las columnas numéricas y de fecha (`buildNumPop`, `buildDatePop`) no cambia.
- Simétrica, no jerárquica: con `Week = W10`, la faceta `Mes` lista solo los meses con W10.

Tests (`tests/table-facet-options.test.ts`): `vtFacetOptions` con dos facetas cruzadas (Mes/Week), con un `numFilter` activo, con el valor seleccionado sin filas (conteo 0 y presente), y control de que la propia faceta no se auto-acota. Control negativo contra `main`: la función no existe. Un test sobre `TABLE_RUNTIME_SOURCE` que verifique que `buildPop` ya no usa `vtDistinct(rows, field)` directo (string contiene `vtFacetOptions(`).

### Entregable de A

Un PR `feat(table): facetas con orden natural (#285) y opciones acotadas por los demás filtros (#286)`, dos commits (uno por hito), CHANGELOG «Sin publicar» con las dos entradas (formato de las de 0.24.0/0.25.0: qué cambia para quien usa un PI, qué se midió), y en el cuerpo del PR: las corridas de control negativo y `Cierra #285` / `Cierra #286`.

---

## Realizador B · #279 — «Aplicar cadencia» no programa corridas en slots alimentados por carga manual

### Dónde está el problema (medido en 0.25.1)

- `server/serve-rls.ts:1926` `applyCadence` y `server/freshness-loop.ts:191-215` (Fase 3 reconciliar) empujan `setScheduleSeconds(processId, requiredCadenceSeconds)` para **todo** proceso con cadencia derivada, sin distinguir si el proceso lo alimenta el motor (Buk, SAP HANA: el schedule es la única forma de refrescar) o una **carga manual** (slot de intake con `trigger.processRef == processId`: subir el archivo ya dispara la corrida; un schedule solo corre sobre nada).
- Los slots viven en `intakeSlotsCfg` / `intakeSlots` (`server/serve-rls.ts:748`, `:1644`, tipo `IntakeSlot` con `trigger?.processRef` en `packages/capabilities/src/intake.ts:148-161`). Hot-reload: leer el arreglo vivo, no una copia.
- Caso real: SJD de Finanzas `31095110-…` con 9 corridas «Completed» de 1 min sobre nada; el schedule se borró a mano el 2026-09-02.

### Diseño

1. Función **pura** en `packages/capabilities/src/freshness.ts`: `manualFedProcesses(slots: Pick<IntakeSlot,'trigger'>[]): Set<string>` — ids de proceso referenciados por algún `trigger.processRef`.
2. `reconcilePlan` (donde viva hoy; buscar su definición) gana un tercer resultado: `{ action: 'vigilar', desiredSeconds }` cuando el proceso es de alimentación manual. Tipar `action: 'set' | 'noop' | 'vigilar'` y propagar el tipo a `server/admin.ts:324`. Alternativa aceptable si `reconcilePlan` es puro y no conoce slots: decidirlo **antes** de llamar a `reconcilePlan`, en los dos callers, con la misma función pura — pero entonces el plan devuelto a la página debe igualmente ser `vigilar`, no `noop`, para que el feedback diga la verdad.
3. `applyCadence`: si el proceso es de alimentación manual → **no llama a `setScheduleSeconds`**; registra `auditLog {type:'frescura-aplicar-cadencia', action:'vigilar'}` y devuelve el plan `vigilar`. Además, si el motor **ya tiene** un schedule activo para ese proceso (`getScheduleSeconds != null`), lo **deshabilita** (`setScheduleEnabled(processId,false)`) y lo dice en el audit (`action:'vigilar', disabledSchedule:true`): el residuo del clic anterior es exactamente lo que #279 midió. No borrar (no hay API de delete en la costura; deshabilitar basta y es reversible).
4. `freshness-loop.ts` Fase 3: saltar los procesos de alimentación manual (como salta los pausados), con un log una sola vez por proceso al arrancar («'X' se alimenta por carga manual: se vigila, no se programa»). Las fases 1 y 2 (observar, alertar por atraso) **no cambian**: la vigilancia es justamente lo que queda.
5. Página de Frescura (`server/admin.ts` sección `frescura` y/o `packages/mira/src/freshness.ts`, donde se pinte el botón «Aplicar cadencia»): para un proceso de alimentación manual, en lugar del botón, el texto «Alimentado por carga manual (slot *label del slot*): la cadencia se vigila, no se programa». El feedback del POST con `action:'vigilar'` dice lo mismo.
6. Los ítems 2 y 3 del issue (filas producidas por corrida; hora local del schedule) **no se construyen** en este PR — dejarlos declarados en el cuerpo del PR como fuera de alcance, con la razón: el motor no expone filas producidas por corrida, y sin schedules en slots manuales el ítem 3 pierde su demandante.

Tests: `tests/freshness-manual-fed.test.ts` — `manualFedProcesses` (con y sin trigger, varios slots al mismo proceso); `applyCadence`/loop con un engine fake que **registra** llamadas: proceso manual → cero `setScheduleSeconds`, `setScheduleEnabled(false)` solo si había schedule; proceso no manual → `set` como hoy (control positivo). Buscar cómo testean hoy `freshness-loop` (hay tests que inyectan `deps`) y seguir ese patrón. Control negativo contra `main`: el engine fake recibe `setScheduleSeconds` para el proceso manual.

### Entregable de B

Un PR `feat(frescura): «Aplicar cadencia» vigila y no programa los procesos alimentados por carga manual (#279)`, CHANGELOG «Sin publicar», cuerpo con las corridas, lo no construido (ítems 2 y 3) y `Cierra #279`.

---

## Qué NO hacer (ambos)

- No tocar `main` ni mergear. No borrar schedules en Fabric ni tocar la VM. No editar specs de la instancia. No añadir dependencias.
- No «arreglar» de paso lo que se vea feo fuera del alcance: anotarlo en el cuerpo del PR bajo «Visto de paso».

## Integración (custodia)

Merge de A y B con CI verde (rebase del CHANGELOG si chocan) → `release: 0.26.0` (CHANGELOG + `package.json` + `package-lock.json` + tag `v0.26.0`) → CI publica la imagen → el operador (misma casa, sombrero cambiado por mandato de César) hace `vergis-rollout install 0.26.0 && promote 0.26.0` sin ventana → verificación en `/pi-15` y en Frescura de Finanzas → avisos en PI-30, PI-1 y cierre de issues.

• *Generado con Wingworking · 2026-09-03*
