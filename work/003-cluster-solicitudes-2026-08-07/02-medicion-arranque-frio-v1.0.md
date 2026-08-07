# 003·B · Medición + fix — ¿el arranque en frío escala con N? — issue #138 pieza 3

**Para el ejecutor (Opus):** brief completo y autocontenido. Fuentes de verdad, en precedencia: (1) este documento, (2) el código en `main`. Si un anclaje de línea se movió, manda el código.

## ¿Qué pide el issue?

«⚠️ No se afirma el mecanismo: no se midió si esa verificación es secuencial o concurrente, ni si el costo es lineal en N. Se pide **primero la medición**; si resulta lineal, paralelizar.» (Los 2,1 s medidos en la instancia: 8 PIs, `push-down: 8/8` a los 2,1 s de servir rutas.)

## Lo que la lectura del código sugiere (hipótesis a PONER EN RIESGO, no a confirmar leyendo)

1. **H1 — El costo NO es lineal en N (PIs).** `verifyFabricServability` (`server/engines/fabric.ts:78-196`) consulta la fuente **por conexión** (`usedRefs`, la unión de `databaseRefs`), en paralelo (`Promise.all`, líneas 92-100); la evaluación por PI es pura en memoria. N PIs sobre las mismas conexiones ⇒ mismo costo de I/O.
2. **H2 — El costo entre conexiones es max, no suma.** El `Promise.all` con try/catch por ref hace que el wall-clock sea el de la conexión más lenta.
3. **H3 — Dentro de cada conexión hay 2 round-trips EN SERIE.** `sourceStateOf` (`server/serve-rls.ts:336-347`) ejecuta `SYS_SECURITY_POLICIES_SQL` y luego `SYS_VIEW_LINEAGE_SQL` con `await` secuenciales ⇒ latencia por conexión ≈ 2 × RTT cuando podría ser ≈ 1 ×.

**Norma 7 de Wingworking:** cada hipótesis necesita una corrida que la habría refutado si fuera falsa. Eso es lo que construyes.

## Trabajo

### 1 · Experimentos de escalamiento (test nuevo `tests/fabric-verify-timing.test.ts`)

Sobre `verifyFabricServability` con un `sourceStateOf` fake que duerme `L = 60 ms` y devuelve un `SourceState` con las tablas protegidas que los PIs piden:

- **E1 (refuta H1 si falla):** 1 conexión; corre con 1 PI y con 40 PIs (todas las tablas gobernadas en el store y protegidas). Aserciones: ambos wall-clocks < `2.5 × L`; si el costo fuera lineal aun a 5 ms/PI, 40 PIs darían > 200 ms. Margen holgado contra jitter de CI.
- **E2 (refuta H2 si falla):** 4 conexiones (cada una duerme L), 8 PIs repartidos. Aserción: wall-clock < `2.5 × L` (secuencial daría ≥ `4 × L` = 240 ms).

Usa contadores de invocación además del tiempo (p. ej. `sourceStateOf` llamado exactamente 1 vez por ref) para que el test no dependa SOLO del reloj.

### 2 · Extraer y paralelizar el par de queries (H3)

El closure `sourceStateOf` inline en `serve-rls.ts:336-347` se extrae a `server/engines/fabric.ts` como factory pura y testeable:

```ts
/** sourceStateOf real: 2 queries de sistema EN PARALELO (Promise.all) — issue #138·3. */
export function createFabricSourceStateOf(
  execute: (input: { database_ref: string; sql: string }) => Promise<{ rows: Record<string, unknown>[] }>,
): (ref: string) => Promise<SourceState>
```

Contenido idéntico al closure actual (mismo parseo de filas, misma dedupe del linaje) pero con las dos `execute` lanzadas juntas y esperadas con `Promise.all`. `serve-rls.ts` pasa a: `sourceStateOf: createFabricSourceStateOf((input) => dwh.execute(input, { agent: 'vergis' }) as Promise<{rows: ...}>)` — semántica de errores intacta (cualquiera de las dos que rechace, rechaza el par; el llamador ya trata el fallo como indeterminación por-ref).

- **E3 (refuta H3-fix si falla):** test con `execute` fake que duerme L=60 ms por query: `createFabricSourceStateOf` completa en < `1.6 × L` (la versión secuencial daría ≥ `2 × L`). Verifica también el shape del resultado (protectedTables y viewLineage correctos, linaje con dedupe).

### 3 · Registrar los números

En tu reporte final: los wall-clocks medidos de E1/E2/E3 (los imprimes con `console.log` en el test o los capturas de la corrida) — el orquestador los cita en el comentario del issue.

## Reglas duras

- **NO editar** `server/admin.ts`.
- La semántica de fail-closed/indeterminación de `verifyFabricServability` **no cambia ni un caso**: `tests/fabric-verify.test.ts` pasa intacto.
- Comandos destructivos (si alguno) acotados a tu worktree por ruta.

## Territorio

`server/engines/fabric.ts` · `server/serve-rls.ts` (solo el bloque `sourceStateOf`, ~336-347) · `tests/fabric-verify-timing.test.ts` (nuevo). Nada más.

## Hecho cuando

1. `npm run typecheck` · `npm test` · `npm run build` verdes.
2. E1, E2, E3 pasan y sus tiempos quedan en el reporte.
3. `tests/fabric-verify.test.ts` sin modificar y verde.

## Entrega

Rama `feat/138-arranque-frio-medicion` desde `main`. Commits en español (`perf(fabric): …`), con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NO pushees ni abras PR: el orquestador integra. Reporta cambios, gates y números.

---
• 🤖 Claude (Fable) · diseño del frente B · cluster 003
