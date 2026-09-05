---
doc_id: 013/04
cluster: 013-cluster-botler-generico
tipo: Brief ejecutable (Fable → realizador Opus)
hito: H2 — store embebido «evaluaciones» e importador de los progresos de Daftar
version: 1.0
fecha: 2026-09-05
issue: "#291"
deriva_de: 01-diseno-rector-botler-generico-daftar-v1.0.md (§2.1 «Stores», §3 B3, §5 fila H2)
gate: typecheck + suite + build + lint:shell verdes · importación de TODOS los progresos reales de Daftar con round-trip deep-equal por archivo · labels de la imagen en verde
---

# Brief H2 — el store `evaluaciones`, con el patrón de la casa, y el importador de Daftar

**Para el realizador.** Se ejecuta **en frío**. Si el terreno contradice el brief, detente y repórtalo en el informe final; no lo resuelvas por tu cuenta.

## 0 · Reglas del repo que no se negocian

Idénticas a las del brief H0 (`02-brief-h0-registro-proto-botlets-v1.0.md` §0): rama + PR contra `main`, worktree propio, **sin `git stash`**, los cuatro gates con salida real en el PR, pie de commits y PR, no mergeas, no cierras issues, Normas 6 y 7. Concretamente:

```sh
cd /Users/cesar/wworkspace/productos/vergis
git worktree add ../vergis-wt-h2 -b feat/botler-h2-store-evaluaciones main
cd ../vergis-wt-h2
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm ci --ignore-scripts
```

**Corres en paralelo con el realizador de H0**, que toca `server/discovery.ts`, `server/serve-rls.ts` (la construcción de `createDiscovery`, ~línea 390) y `packages/botler`. Tú tocas `serve-rls.ts` en **otras dos regiones** (la apertura de stores y `embeddedStores()`); antes de abrir el PR haz `git fetch origin && git rebase origin/main` y resuelve si chocan. **No corras el banco de anillos** (no lo necesitas y el otro realizador puede estar usándolo).

## 1 · Qué se construye, en una frase

Un **store embebido** `evaluaciones` (SQLite sobre `packages/capabilities/src/sqlite.ts`, esquema 1) que persiste lo que el evaluador de Daftar necesita —instrumento publicado, intento, respuesta con confianza, resultado por sección, revisión, reporte—, cableado al nodo con **el mismo patrón que `notas` y `data-maestra`** (apertura no fatal, `reopen` en el relevo, `controlStatus` en el bloque `control` de `/contrato`, label `vergis.schema.stores`), y un **importador idempotente** desde los JSON de Daftar cuya prueba de cero pérdida es reconstruir el JSON original byte a byte en su forma canónica.

## 2 · El terreno, medido el 2026-09-05

### 2.1 · El patrón de la casa (léelo antes de escribir)

| Pieza | Dónde | Qué imitar |
|---|---|---|
| Store de referencia | `packages/capabilities/src/notas-store.ts` | `NOTAS_SCHEMA_VERSION = 1`; clase con `static open(file, control)`, `private static openDb()` que llama `openSqliteDb(file, { ...control, schemaVersion })` y corre los DDL `CREATE TABLE IF NOT EXISTS`; `reopen(control)` con validate-before-swap; `controlStatus()` = `sqliteControlStatus(this.db)`; `persist()` = `persistSqliteDb(this.db, this.file)` **tras cada mutación**; `openNotasStore(baseDir, control)` que resuelve el archivo desde `VERGIS_NOTES_DB` o `${baseDir}/notas.sqlite` |
| El guard de SQLite | `packages/capabilities/src/sqlite.ts` | `openSqliteDb`, `persistSqliteDb`, `sqliteControlStatus`, `selectAll`; los errores `SqliteSchemaTooNewError`, `SqliteEpochFencedError`, `SqliteConcurrentWriteError`. **No lo modificas** |
| Exportaciones | `packages/capabilities/src/index.ts` líneas ~66-81 (notas), ~139 (data maestra), ~164 (gobierno) | Exporta la clase, la constante de esquema y los tipos |
| Cableado en el nodo | `server/serve-rls.ts`: notas se abre ~línea 1036 («Apertura NO-FATAL…»); data maestra ~línea 1260 con `storeControl()`; `embeddedStores()` ~línea 2308 lista `gobierno`, `notas`, `data-maestra` con `reopen` y `status` | La función `storeControl()` (búscala con `grep -n 'storeControl' server/serve-rls.ts`) provee época y writer |
| Contrato | `server/contract.ts` `ControlContract.store[]` | Se deriva de `embeddedStores()`: **no hay que tocar `contract.ts`** |
| Label de la imagen | `Dockerfile` líneas ~68-69: `LABEL vergis.schema="1" vergis.schema.stores="gobierno=1,notas=1,data-maestra=1"` | `tests/imagen-anillo-labels.test.ts` exige que las claves del label sean **exactamente** los `out.push({ name: '…' })` de `embeddedStores()` y que cada número sea la constante del código |
| Tests de referencia | `tests/notas-store.test.ts`, `tests/store-reopen-relevo.test.ts`, `tests/sqlite-control-plane.test.ts` | Forma de abrir en memoria (`file: null`) y de probar `reopen` |

### 2.2 · Los datos de Daftar (fuente del importador)

Rutas en esta máquina (fuera del repo; **no se copian al repo**):

| Qué | Dónde | Medido 2026-09-05 |
|---|---|---|
| Progresos | `/Users/cesar/wworkspace/estudios/daftar/app/progress/*.json` | **55 archivos**, 43 con `_finishedAt` |
| Guías (instrumentos) | `/Users/cesar/wworkspace/estudios/daftar/app/guides/*.json` | 60 archivos. Claves raíz: `title code subtitle subject group variant mode institution student department sections` siempre; `new sprint sprintOrder invalidated invalidated_reason focus confidence` a veces |
| Reportes | `/Users/cesar/wworkspace/estudios/daftar/app/reports/*.json` | 3 archivos. Claves: `id title subtitle summary student sprint sprintOrder subject group related_guides generated_at content_html` |
| Servidor que los escribe | `/Users/cesar/wworkspace/estudios/daftar/app/server.py` `_save_progress` (~línea 151), `_save_review`; `static/app.js` líneas 63-130 (confianza) y 321-353 (`_startedAt/_finishedAt`) | Solo para entender; **no se modifica** |

**Forma real de un progreso**, con las variantes que existen (verifícalo con un script antes de modelar):

```jsonc
{
  "guideId": "009-lengua-refuerzo-sujeto-escritura",
  "currentSection": 6,
  "totalSections": 8,
  "_startedAt": "2026-03-25T00:04:30.462Z" | null,
  "_finishedAt": "…" | null,
  "last_updated": "2026-03-24T21:04:30.467801",     // lo escribe server.py en cada POST
  "last_reviewed": "…",                              // solo 3 archivos
  "locked": true,                                    // solo 1 archivo
  "sections": {                                      // dict con claves "0","1",… (índice de sección)
    "0": {
      "answers": [ … ],                              // ver abajo
      "attempts": 3,                                 // ausente en algunas secciones
      "checked": true,                               // ausente en algunas
      "score": { "correct": 8, "total": 8 },         // ausente en algunas
      "review": { … }                                // solo 4 secciones; DOS formas distintas (abajo)
    }
  }
}
```

`answers[i]` es **heterogéneo**, y ese es el punto que decide el modelo: en 1.082 respuestas medidas hay `string` (1.060: índice `"2"`, texto libre, valor de `fill`/`classify`), `null` (9, sin responder), y `object` (13) — de los cuales la forma `{ "choice": "2", "conf": "S" }` es la de **confianza S·C·A** (opt-in por guía, `"confidence": true`), y otra forma es un **mapa palabra → categoría** de ejercicios `highlight` (`{"lentamente": "adverbio", …}`). `review` tiene dos formas: `{ score: "6/10", form: "F", comments: [{ fondo, forma, comment }] }` y `{ reviews: … }`.

**Consecuencia de modelo (decidida):** el valor de cada respuesta se guarda **verbatim como JSON canónico** (`valor_json`), y la confianza se **deriva** a una columna propia (`confianza` ∈ `S|C|A|NULL`) **solo** cuando el valor tiene la forma `{choice, conf}`. Nada se interpreta, nada se pierde, y la consulta «errores marcados S» sale de una columna indexable. Lo mismo para `review` (`revision_json`) y para cualquier clave raíz o de sección que no esté modelada (`extra_json`): el round-trip de §5 es lo que te obliga a no dejar nada afuera.

## 3 · Diseño (decidido; no se rediseña)

### 3.1 · `packages/capabilities/src/evaluaciones-store.ts`

```ts
export const EVALUACIONES_SCHEMA_VERSION = 1
```

Tablas (DDL `CREATE TABLE IF NOT EXISTS`, con índices por `instrumento_id`, `estudiante`, `intento_id`):

| Tabla | Columnas | Notas |
|---|---|---|
| `instrumento` | `id TEXT PK` (= id de la guía, p. ej. `051-matematica-preu-clase-02-naturales-enteros-ii`) · `titulo` · `codigo` · `subtitulo` · `materia` · `grupo` · `variante` · `modo` (`practice`/`exam`) · `institucion` · `estudiante` (**del JSON, por ahora**: H4 lo muda al directorio de identidad) · `departamento` · `confianza INTEGER` (0/1) · `total_secciones INTEGER` · `total_items INTEGER` · `sha256 TEXT` (del archivo JSON tal cual) · `publicado_at TEXT` · `retirado_at TEXT NULL` · `invalidado INTEGER` · `invalidado_razon TEXT NULL` · `extra_json TEXT` | **Inmutable por id** (B3): re-publicar el mismo id con otro sha es **conflicto** (error estructurado), no upsert. `retirar(id)` pone `retirado_at`, jamás borra |
| `intento` | `id TEXT PK` (uuid) · `instrumento_id` · `estudiante` · `seccion_actual INTEGER` · `total_secciones INTEGER` · `iniciado_at TEXT NULL` · `terminado_at TEXT NULL` · `actualizado_at TEXT` · `revisado_at TEXT NULL` · `bloqueado INTEGER` · `extra_json TEXT` · `UNIQUE(instrumento_id, estudiante)` | La unicidad refleja lo que Daftar hace hoy (un progreso por guía); un re-take de verdad nace como instrumento nuevo, que es la regla del proyecto estudios |
| `intento_seccion` | `intento_id` · `seccion INTEGER` · `intentos INTEGER NULL` · `revisada INTEGER NULL` (= `checked`) · `correctas INTEGER NULL` · `total INTEGER NULL` · `revision_json TEXT NULL` · `extra_json TEXT` · `PK(intento_id, seccion)` | `checked`/`score` ausentes ⇒ `NULL`, no `0`: la ausencia es información |
| `respuesta` | `intento_id` · `seccion INTEGER` · `indice INTEGER` · `valor_json TEXT` (canónico; `null` JSON para sin responder) · `confianza TEXT NULL` · `PK(intento_id, seccion, indice)` | `confianza` derivada solo de `{choice, conf}` |
| `reporte` | `id TEXT PK` · `estudiante` · `titulo` · `subtitulo` · `resumen` · `materia` · `grupo` · `sprint` · `sprint_orden INTEGER NULL` · `relacionados_json` · `generado_at` · `contenido_html` · `extra_json` | Es el artefacto de devolución de Daftar; se conserva como está |

API mínima de la clase `SqliteEvaluacionesStore` (todo `persist()` tras mutar): `publicarInstrumento(input)` · `retirarInstrumento(id, at)` · `instrumento(id)` · `instrumentos({ estudiante?, vigentes? })` · `guardarIntento(intentoCompleto)` (reemplazo atómico de intento + secciones + respuestas, que es lo que Daftar hace con cada POST) · `intento(instrumentoId, estudiante)` · `intentosDe(estudiante)` · `bloquear(intentoId)` · `guardarRevision(intentoId, seccion, revision)` · `guardarReporte(r)` · `reportes(estudiante?)` · `reporte(id)` · `reopen(control)` · `controlStatus()`. Más `openEvaluacionesStore(baseDir, control)` que resuelve `VERGIS_EVALUACIONES_DB ?? ${baseDir}/evaluaciones.sqlite`.

Errores como `VergisError` estructurado (`@vergis/botler`), p. ej. `evaluaciones/instrumento-inmutable`.

### 3.2 · El importador, en `packages/capabilities/src/evaluaciones-import.ts` + `scripts/evaluaciones-importar.ts`

Función pura y testeable `importarDaftar({ guides: {id → json}, progress: {id → json}, reports: {id → json}, store, now })` que:

1. publica cada guía como instrumento (id = nombre del archivo sin `.json`; `sha256` del texto; `total_items` = suma de `exercises` de sus secciones; `confianza` = `!!json.confidence`); si el id ya existe **con el mismo sha**, no hace nada (idempotente); con **otro sha**, reporta conflicto y no toca;
2. por cada progreso crea/reemplaza el intento de `(guideId, estudiante)` — el estudiante sale de la guía (`student`); si la guía no está, el progreso se reporta como **huérfano** y no se importa;
3. importa los reportes tal cual;
4. devuelve un **informe por guía**: `{ id, respuestas, secciones, revisiones, estado: 'importado'|'sin-cambios'|'huerfano'|'conflicto' }`.

Y la inversa, **la que prueba la ausencia de pérdida**: `exportarProgreso(store, instrumentoId, estudiante): unknown` reconstruye el JSON del progreso con la forma de Daftar (`guideId`, `currentSection`, `totalSections`, `_startedAt`, `_finishedAt`, `last_updated`, `sections` como dict de índices, y cada clave rara —`locked`, `last_reviewed`, `review`, `extra`— donde estaba).

`scripts/evaluaciones-importar.ts` (tsx, como los demás de `scripts/`): `--guides <dir> --progress <dir> --reports <dir> --db <archivo> [--verificar]`. Con `--verificar` corre el round-trip contra cada archivo de progreso y termina con código ≠ 0 si alguno difiere, imprimiendo **solo** el id y las rutas del JSON que difieren (nunca el contenido: son datos de menores). Imprime la tabla por guía.

### 3.3 · Cableado en `server/serve-rls.ts`

- Apertura **no fatal**, en el mismo bloque donde se abren notas y data maestra, **solo si** `VERGIS_EVALUACIONES=1` o `VERGIS_EVALUACIONES_DB` está definida (una instancia sin evaluador no crea el archivo). Regístralo con `contract.env(...)` como hacen los demás para que el `/contrato` lo derive.
- `embeddedStores()` gana `if (evaluacionesSqlite) out.push({ name: 'evaluaciones', reopen: …, status: … })`.
- `Dockerfile`: `vergis.schema.stores="gobierno=1,notas=1,data-maestra=1,evaluaciones=1"`.
- `tests/imagen-anillo-labels.test.ts`: agrega `evaluaciones: EVALUACIONES_SCHEMA_VERSION` al mapa esperado (importado de `@vergis/capabilities`).
- **Sin rutas nuevas**: el proto-Botlet que las sirve es H3.

## 4 · Tests que este hito entrega

`tests/evaluaciones-store.test.ts` (store en memoria, `file: null`):
1. publicar instrumento, leerlo, listar por estudiante y vigentes; retirar no borra.
2. re-publicar el mismo id con otro sha lanza `evaluaciones/instrumento-inmutable`; con el mismo sha es no-op.
3. `guardarIntento` reemplaza atómicamente (un segundo guardado con menos respuestas deja exactamente las nuevas).
4. `confianza` se deriva de `{choice, conf}` y queda `NULL` para string, `null` y mapas.
5. `bloquear` y `guardarRevision` persisten y se leen.
6. `reopen` con otra época conserva los datos (patrón de `store-reopen-relevo.test.ts`).

`tests/evaluaciones-import.test.ts` con **fixtures sintéticas** en `tests/fixtures/evaluaciones/` (inventadas, sin datos reales) que cubran cada variante de §2.2: respuesta string, `null`, `{choice,conf}`, mapa palabra→categoría, sección sin `attempts`/`checked`/`score`, `review` en sus dos formas, `locked`, `last_reviewed`, progreso huérfano, guía con `confidence: true`:
7. importar dos veces es idempotente (mismo informe la segunda vez con `sin-cambios`).
8. **round-trip**: para cada fixture de progreso, `exportarProgreso` deep-equal al original.
9. huérfano reportado, no importado; conflicto de sha reportado, instrumento intacto.

`tests/imagen-anillo-labels.test.ts` actualizado (§3.3).

## 5 · El gate, en orden

1. `npm run typecheck && npm test && npm run build && npm run lint:shell` verdes; conteo de tests antes/después.
2. **Control negativo obligatorio:** en `exportarProgreso`, omite deliberadamente `last_reviewed` (o `locked`) y corre la suite: el test 8 debe ponerse **rojo** nombrando el archivo. Restaura con `git checkout HEAD -- <archivo>`.
3. **La medición contra los datos reales**, fuera del repo, con salida solo de conteos:
   ```sh
   npx tsx scripts/evaluaciones-importar.ts \
     --guides   /Users/cesar/wworkspace/estudios/daftar/app/guides \
     --progress /Users/cesar/wworkspace/estudios/daftar/app/progress \
     --reports  /Users/cesar/wworkspace/estudios/daftar/app/reports \
     --db /tmp/evaluaciones-h2.sqlite --verificar
   ```
   Se exige: **55 progresos** con estado `importado` (o el número real que haya ese día, dicho), **0 diferencias** en el round-trip, 60 instrumentos, 3 reportes. Pega la tabla por guía en el PR (ids y conteos; **ningún contenido de respuesta**). Corre el comando **dos veces**: la segunda debe dar todo `sin-cambios`.
4. Borra `/tmp/evaluaciones-h2.sqlite` al terminar (contiene texto escrito por menores).

## 6 · CHANGELOG y catálogo

- `CHANGELOG.md` → «Sin publicar», `###` propio citando **#291**. Para el operador: **la imagen declara un store más** (`evaluaciones=1`) y **no se abre** salvo con `VERGIS_EVALUACIONES=1`/`VERGIS_EVALUACIONES_DB`; una instancia A.R.B.O.L. que promueva no ve archivo nuevo ni cambio de contrato. Di qué se midió (round-trip 55/55) y qué no (nada sirve todavía estas tablas: H3).
- `npm run capacidades:cotejo`: si exige fila `CAP-NN`, agrégala describiendo la superficie real (label + env + bloque `control.store[]` de `/contrato`).
- No subes versión ni cortas tag.

## 7 · Lo que NO se hace en H2

- Ninguna ruta HTTP, ningún HTML, nada de `packages/daftar` (H3).
- No se toca `sqlite.ts`, `contract.ts`, ni el plano de control.
- No se mueve `student` fuera del JSON de la guía (H4).
- No se commitean datos reales de Daftar (ni progresos ni guías ni reportes): fixtures sintéticas únicamente.

## 8 · El informe final

Igual que §8 del brief H0: rama y PR; salida de los cuatro gates y conteo de tests; qué se puso rojo en el control negativo; la tabla de la importación real (conteos) y el resultado de la segunda corrida; archivos tocados; lo que contradijo al brief; lo que quedó **sin medir**, con esas palabras.

---

*Doc 013/04 · Brief H2 · v1.0 · 5 de septiembre de 2026*

• *Generado con Wingworking*
