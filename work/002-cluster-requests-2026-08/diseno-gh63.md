# Diseño #63 — «Revertir esta carga»: rollback de una carga como acción de primera clase (TX-07)

**Issue:** [Gegolabs/vergis#63] `feat(intake): «Revertir esta carga» — rollback de una carga como acción de primera clase (TX-07)`
**Rol de este documento:** contrato de delegación (ww:wingcoding). Lo ejecuta un agente Opus en frío: todo lo necesario está aquí o referenciado por ruta exacta.
**Repo:** `/Users/cesar/wworkspace/productos/vergis` (monorepo TS; workspaces `packages/*` + `server/` + `tests/` vitest).
**Gates:** `npm run typecheck` && `npm test` && `npm run build`. Producto pre-launch: rige el criterio de excelencia, sin scope creep.

**BASE = main + #62.** Este diseño ASUME que el diseño de #62 (`diseno-gh62.md`, mismo directorio) ya está mergeado: existen la tabla `intake_upload` del GovernanceStore (id, slot_id, filename, sha256, origen, dup_of…), la interfaz `IntakeUploadStore` (`recordUpload`/`findUploadBySha`/`listUploads`), el backfill retroactivo de `_processed/` (filas `origen:'retro'` con sha), y `CargasOps.history` leyendo del store. Nada de #62 se re-diseña aquí; si al arrancar la rama #62 aún no está en main, rebasar sobre su rama antes de empezar. Familia declarada: hash = **identidad** (#62) · delta neto = **semántica** (#62) · rollback = **reversibilidad** (#63, este documento).

---

## ¿Qué pide el issue?

Botón **«Revertir esta carga»** como acción de primera clase sobre el timeline de Actividad, que ejecute la compensación derivada del ledger carga→claves:

1. **Ledger carga→claves**: saber, por carga, qué claves (OC / semana) materializó su conversión.
2. **Compensación por clave, en TX**: (a) clave con versión anterior en `_processed/` → reactivar esa versión y re-materializar; (b) clave **introducida** por la carga (sin versión previa) → DELETE de la clave (hoy sin camino en la UI: queda dato huérfano que solo sale con DML manual); (c) registrar la reversión como conversión compensatoria en Actividad, auditable, con el archivo revertido en `_retirado/` con tag «revertido».
3. **Idempotente y acotado** a las claves de ESA carga — jamás un truncate del slot.

Precondición declarada por el issue (contrato de ingesta de la instancia): conversión transaccional-por-clave (DELETE+INSERT) + dedup last-wins + archivado a `_processed/<clave>/` — hace la compensación bien definida.

## ¿Qué existe ya en main? (fase 1, verificada contra el código el 2026-08-06)

Una **fase 1** de #63 ya está en producción (CHANGELOG líneas 174–177). Verificado:

| Pieza | Dónde | Estado |
|---|---|---|
| `CargasOps.revert?(slot, archivedPath, by)` | `server/admin-cargas.ts` 56–59 | ✅ existe — por **archivo archivado**, no por carga |
| Implementación | `server/serve-rls.ts` 886–912: copia a `_retirado/<ts>-revertido-<base>`, remove de `_processed/`, reactiva el archivo más reciente que QUEDA en `_processed/<clave>/`, `runNow` si reactivó | ✅ existe |
| Acción POST + audit | `server/admin.ts` 895–908: `accion=revert`, guard `/_processed/` + anti-traversal, evento audit `type:'intake-revert'` (`clave`, `compensada`, `reactivado`) | ✅ existe |
| Botón «Revertir» | `admin-cargas.ts` 242: en la tabla **Procesados**, con `confirm()` estático | ✅ existe |
| Tests | `tests/admin-cargas.test.ts` 370–413 | ✅ existen (fase 1) |

### ¿Qué brechas cierra este diseño?

1. **No hay acción por CARGA** — el operador revierte archivo por archivo desde Procesados; el timeline de Actividad (donde vive la carga como evento) no ofrece nada.
2. **El caso «clave introducida» miente a medias** — fase 1 mueve el archivo a `_retirado/` y avisa que el dato queda huérfano (`admin.ts` 907): la UI dice «revertida» pero el warehouse conserva el dato. Sin camino de DELETE.
3. **Sin confirmación informada** — el `confirm()` estático no dice qué claves se afectan ni qué pasará con cada una.
4. **Sin protección contra cargas posteriores** — fase 1 reactiva «el más reciente que queda», aun si el archivo revertido NO era la versión vigente de la clave: revertir una versión intermedia reordena el histórico sin cambiar el dato (y miente).
5. **Sin registro consultable** — la reversión vive solo en el audit log JSONL; el timeline no la muestra.
6. **Sidecars huérfanos** — retirar/reactivar mueve el archivo de datos pero no su `<archivo>.meta.json` (#76); una versión previa reactivada sin su sidecar llega al convertidor sin metadata.
7. **Sin idempotencia declarada** — un fallo a mitad de la secuencia copy→remove→reactivar→run deja estado intermedio sin camino de convergencia.

## ¿Cómo es la arquitectura relevante? (mapa verificado)

- **Layout del ciclo** (`serve-rls.ts` 831–834): `<padre-del-landing>/_processed/<clave>/<archivo>` = lo archivado por el convertidor tras procesar; `<padre>/_retirado/` = retiros manuales. `archived` lista `_processed` recursivo; la UI filtra sidecars (`isSidecarName`).
- **El convertidor es un SJD de la INSTANCIA, fuera de este repo** (ADR-001: Vergis no parsea planillas). Vergis solo ve: (a) el log del slot (`slotLogPath`, default `Files/code/_ingest_log.txt` — texto libre, **se sobreescribe por corrida**: «el log pertenece a la ÚLTIMA conversión», `admin-cargas.ts` 164), y (b) el estado del job vía `jobs/instances` (`createFabricJobStatus`). No hay callback de fin de conversión ni contadores estructurados.
- **Sidecars** (#76/#95): `<archivo>.meta.json` viaja con el archivo; el orden de escritura es sidecar ANTES que archivo («el SJD nunca vea un archivo de datos sin su sidecar», `intake-onelake.ts` 24–28); un sidecar suelto es inocuo («el SJD procesa archivos, no sidecars sueltos», `intake-onelake.ts` 75). Precedente de directiva declarada-por-Vergis-ejecutada-por-el-convertidor: `verify` (#95, `intake.ts` 59–68).
- **POST de la consola**: `admin.ts` 246–261 — `readForm` + CSRF + slot del dominio → `handleCargasAccion` → SIEMPRE redirect PRG con `msg`. Gate de steward: lo aplica el ruteo del dominio.
- **`OneLakeReader`** (`intake-onelake.ts` 98–178): `read`/`readBytes`/`list`/`copy`/`remove` — todo lo que el motor de compensación necesita. `remove` es no-op en 404; `copy` es create+append+flush (overwrite idempotente).
- **Post-#62**: `intake_upload` da id + sha256 por carga (incluyendo `origen:'retro'` para lo procesado antes de 0.7.0); `findUploadBySha` resuelve contenido→carga.

**Hechos vs conjeturas de este mapa** (Norma 6): todo lo anterior está verificado contra el código en las rutas citadas, SALVO: (a) si el convertidor archiva también los sidecars en `_processed/` — no verificable desde este repo, **conjetura**: el diseño lo trata como opcional (copy best-effort, tolera 404); (b) si una carga puede materializar VARIAS claves y cómo la refleja el layout (¿copia del archivo bajo cada `_processed/<clave>/`?) — **conjetura**: el diseño es robusto a ambos casos (deriva las claves de TODAS las apariciones del archivo en `_processed/`); (c) si el pipeline sobreescribe en `_processed/<clave>/` un archivo del mismo nombre — **conjetura**: el diseño resuelve identidad por sha, no por nombre.

---

## Decisiones selladas

### D1 — El ledger carga→claves ES el layout `_processed/<clave>/<archivo>`; el GovernanceStore ancla identidad y registra reversiones — NO duplica el mapeo

El issue propone persistir las claves por carga en el GovernanceStore. **Decisión contraria, con racional:**

- **Vergis no tiene el momento de captura.** La conversión corre asíncrona en Fabric; Vergis no recibe callback y el log del slot se sobreescribe por corrida — capturar `OCs=[…]` exigiría un poller que llegue a tiempo, parseando texto libre por-instancia, y una corrida re-run procesa TODOS los archivos del landing (la atribución carga→clave desde el log es ambigua con >1 archivo).
- **El layout ya ES el ledger, mantenido por el único actor que sabe** — el convertidor lo escribe atómicamente con la conversión, cubre la historia pre-Vergis, y sobrevive reinicios. El comentario de fase 1 lo dice tal cual (`serve-rls.ts` 886–887).
- **Copiarlo al store sería scrapear la fuente con drift garantizado**: dos fuentes de verdad donde el pipeline (fuera del repo) solo mantiene una.
- Criterio de excelencia: si nada existiera, el mapeo viviría donde lo produce su dueño. Se consulta ahí.

**Lo que SÍ persiste el GovernanceStore** (hechos de Vergis, no del convertidor):

1. **Identidad de la carga** — `intake_upload` (#62, ya existe). La resolución carga↔archivo archivado se hace por `filename` (candidatos) verificado por `sha256` (identidad), ver D2.
2. **El registro de reversiones** — tabla nueva `intake_revert` (D6): quién revirtió qué, cuándo, con qué resultado por clave. Es el evento que el timeline muestra y la fuente consultable; el audit log sigue siendo evidencia.

### D2 — La unidad de reversión es la CARGA (fila 📤 del timeline), y el plan se deriva así

- **Ancla**: `intake_upload.id`. `IntakeUploadEvent` gana `id?: number` (aditivo — #62 selló que su forma no cambiaba *en #62*; extenderla es materia de #63) y el wiring de `history` lo puebla desde `listUploads`.
- **El botón «Revertir esta carga»** aparece en cada fila 📤 Carga del timeline cuando `id != null && sha256 && ok` (una carga rechazada no materializó nada). Cargas migradas sin sha → sin botón (la identidad no es verificable; fail-closed) — para ellas queda el camino por archivo desde Procesados.
- **Derivación del plan** (sin mutar nada):
  1. `reader.list(target, '<padre>/_processed', {recursive:true})` — un solo call, el mismo de `archived`.
  2. Candidatos: entradas no-directorio, no-sidecar, con `basename == filename` de la carga.
  3. Por candidato: `readBytes` + sha256. **sha == sha de la carga** → este archivo ES la materialización de la carga en la clave `<primer segmento tras _processed/>`. **sha !=** → un archivo del mismo nombre pisó esa copia: la carga ya no está materializada ahí (cuenta como pisada, D3.iii, con el archivo vigente como evidencia).
  4. **Vigencia por clave**: la copia de la carga es *vigente* en la clave K si su `lastModified` es el máximo entre los archivos de datos de `_processed/K/` (del mismo listado; sin llamadas extra).
  5. **Copias en el landing**: `reader.list(target, slot.target.path)`; entrada no-sidecar con `basename == filename` y sha coincidente → se retira en la ejecución (una carga aún no procesada, o residuo, se revierte retirándola: cobertura del caso «la conversión falló / no corrió»).
  6. Candidato directamente bajo `_processed/` sin directorio de clave → **sin clave derivable**: se reporta y NO se toca (fail-closed).
- El costo de `readBytes` está acotado a los candidatos por nombre (unidades, no el archivo completo del slot).
- Desde **Procesados**, el botón «Revertir» por archivo se conserva y entra al MISMO flujo: el plan se deriva de esa única ruta archivada (clave del path, sha del archivo; `findUploadBySha` resuelve el `uploadId` si existe — puede no existir, el plan funciona igual con `uploadId` ausente).

### D3 — Semántica EXACTA de revertir, por clave de la carga

Para cada clave K donde la carga C tiene copia archivada:

- **(i) C vigente en K, con versión previa** (queda al menos otro archivo de datos en `_processed/K/`): la clave **vuelve a su versión anterior** = se reactiva al landing el archivo más reciente que queda en `_processed/K/` (sidecar primero si existe, D4), el archivo de C va a `_retirado/<ts>-revertido-<base>`, y la conversión re-corre (last-wins re-materializa el estado anterior). Es el flujo probado retiro+reactivación+re-run, compuesto y automático.
- **(ii) C vigente en K, SIN versión previa** (C introdujo la clave): la clave **queda VACÍA** — DELETE sin INSERT. Vergis NO ejecuta DML (el warehouse lo escribe solo el convertidor): escribe un **manifiesto de reversión** en el landing (D8) que el convertidor ejecuta como DELETE de la clave en la corrida. **Solo si el slot declara `revert_delete: true`** en `slots.yaml`; sin la declaración, la clave se reporta **no-compensable y NO se toca** — ni el archivo se mueve (fail-closed: mover el archivo dejando el dato materializado es la mentira de fase 1, que este diseño retira; el plan lo explica con sus palabras).
- **(iii) K pisada por una carga posterior** (la copia de C no es la vigente, o fue sobreescrita por otro contenido del mismo nombre): **sin efecto — no se toca nada de esa clave**. El dato vigente de K no proviene de C; «revertir» C ahí no restaura ningún estado y mover su copia archivada corrompería la cadena de versiones que una reversión futura de la carga vigente necesita. El plan lo dice: `sin efecto: la clave «K» fue pisada por una carga posterior («X.xlsx», <fecha>) — para deshacerla, revertí esa carga primero`. **Solo la carga vigente de una clave es reversible en esa clave.**
- **(iv) Copia de C en el landing** (no procesada aún, o residuo): se retira a `_retirado/` con su sidecar — no se re-procesará.

Una carga puede combinar los cuatro casos entre sus claves: el plan ejecuta (i), (ii) y (iv), y reporta (iii) y los no-compensables sin tocarlos. **Si el plan no contiene ninguna acción con efecto, no se ejecuta nada** y la página lo explica. Jamás se toca una clave ajena a la carga; jamás un truncate.

### D4 — Un solo motor de compensación: `packages/capabilities/src/intake-revert.ts` (nuevo)

Módulo de capability (testeable con reader/jobs falsos), consumido por el wiring. Reusa `OneLakeReader` + `FabricJobs` — el write-path `createOneLakeIntake` NO se toca.

```ts
import type { OneLakeReader, FabricJobs } from './intake-onelake'
import type { IntakeSlot } from './intake'
import type { IntakeUploadStore } from './governance-store' // #62

export type ClaveAccion =
  | { clave: string; accion: 'rematerializar'; revertido: string; previa: string }   // D3.i  (rutas archivadas)
  | { clave: string; accion: 'vaciar'; revertido: string }                           // D3.ii con revert_delete
  | { clave: string; accion: 'no-compensable'; revertido: string }                   // D3.ii sin revert_delete
  | { clave: string; accion: 'pisada'; revertido: string; vigente: string }          // D3.iii
  | { clave: string; accion: 'sin-clave'; revertido: string }                        // bajo _processed/ sin dir de clave

export interface RevertPlan {
  slotId: string
  uploadId?: number
  filename: string
  sha256: string
  claves: ClaveAccion[]
  /** Rutas en el landing (archivo de datos) que la ejecución retira (D3.iv). */
  landing: string[]
  /** ¿Hay al menos una acción con efecto (rematerializar | vaciar | landing)? */
  ejecutable: boolean
  /** SHA-256 hex del JSON canónico del plan (D5). */
  hash: string
}

export interface RevertDeps {
  reader: OneLakeReader
  jobs?: FabricJobs
  uploads?: IntakeUploadStore
}

/** Deriva el plan sin mutar nada. `ref` por carga (uploadId) o por archivo archivado (Procesados). */
export function deriveRevertPlan(deps: RevertDeps, slot: IntakeSlot,
  ref: { uploadId: number } | { archivedPath: string }): Promise<RevertPlan>

export interface RevertResult { resumen: ClaveAccion[]; landingRetirado: boolean; convirtiendo: boolean }

/** Re-deriva, compara `hash`; si difiere devuelve el plan fresco (el caller re-confirma). */
export function executeRevertPlan(deps: RevertDeps, slot: IntakeSlot, planHash: string,
  ref: { uploadId: number } | { archivedPath: string }): Promise<{ ok: true; result: RevertResult } | { ok: false; plan: RevertPlan }>
```

- `hash` = sha256 (`node:crypto`) del `JSON.stringify` de `{slotId, filename, sha256, claves, landing}` con `claves` y `landing` ordenados determinísticamente (por clave / por ruta).
- **Orden de ejecución por clave — convergencia primero** (D7): (1) asegurar el insumo de compensación — reactivar la previa al landing (sidecar primero, ambos overwrite-idempotentes; sidecar con `catch` tolerante: su ausencia en `_processed/` es la conjetura (a)) o escribir el manifiesto de reversión (D8); (2) copiar el archivo de C a `_retirado/<Date.now()>-revertido-<base>` (con su sidecar, best-effort); (3) `remove` de la copia de C en `_processed/K/` (y su sidecar, best-effort). Las claves se procesan todas; los retiros del landing (D3.iv) después (mismo patrón copy→remove); **un solo `runNow` al final**, solo si `slot.trigger` y hubo (i) o (ii). Este orden garantiza que un crash intermedio deja el plan re-derivable convergiendo (si C sigue en `_processed/`, el plan lo re-encuentra; jamás se borra C antes de asegurar su compensación).
- **El `CargasOps.revert?` de fase 1 se elimina** (superseded): la interfaz gana `revertPlan`/`revertExec`/`reverts` (D6) y el botón de Procesados posta `accion=revert-plan&archivo=…`. Los tests de fase 1 (`tests/admin-cargas.test.ts` 370–413) se reescriben al flujo nuevo — son tests de #63 superados por #63; el criterio de excelencia manda sobre lo ya implementado.

```ts
// server/admin-cargas.ts — CargasOps (diff)
export interface CargasOps {
  // …existentes sin cambio (history ahora puebla IntakeUploadEvent.id, wiring)…
  /** Reversiones registradas del slot (D6), recientes primero. */
  reverts?(slot: IntakeSlot, limit: number): Promise<IntakeRevertRow[]>
  revertPlan?(slot: IntakeSlot, ref: { uploadId?: number; archivedPath?: string }): Promise<RevertPlan>
  revertExec?(slot: IntakeSlot, planHash: string, ref: { uploadId?: number; archivedPath?: string }, by: string):
    Promise<{ ok: true; result: RevertResult } | { ok: false; plan: RevertPlan }>
}
```

### D5 — Confirmación en dos fases con plan sellado (acción destructiva sobre datos)

El `confirm()` estático no puede mostrar un plan derivado. Flujo sellado:

1. **POST `accion=revert-plan`** (con `upload=<id>` o `archivo=<ruta archivada>`) → el server deriva el plan y responde **200 con la página de confirmación** (excepción puntual al PRG del dispatch de cargas, `admin.ts` 246–261: la rama `revert-plan` hace `send(res, 200, …)` en vez de redirect; los errores siguen cayendo al PRG con `msg`). La página lista **el resumen por clave** con los textos sellados:
   - rematerializar → `la clave «K» vuelve a su versión anterior: se re-materializa «<previa>»`
   - vaciar → `la clave «K» queda VACÍA — esta carga la introdujo (DELETE sin INSERT; lo ejecuta el convertidor)`
   - no-compensable → `la clave «K» NO se puede vaciar desde acá: el convertidor de esta instancia no declara soporte de reversión (revert_delete) — la clave no se toca`
   - pisada → `sin efecto: la clave «K» fue pisada por una carga posterior («X», <fecha>) — para deshacerla, revertí esa carga primero`
   - sin-clave → `«<ruta>» está archivado sin clave: no se puede derivar compensación — no se toca`
   - landing → `la copia en el landing se retira (no se re-procesará)`
2. La página trae un form **POST `accion=revert-exec`** con hidden `hash` + `upload`/`archivo` + `_csrf`, botón «Revertir esta carga» con `confirm()` nativo (`Esta acción modifica el dato del warehouse según el plan de arriba. ¿Confirmar?` — cinturón y tirantes, pauta `postForm`). Si `!plan.ejecutable`, NO hay form: solo la explicación y el link de vuelta.
3. **En `revert-exec` el server re-deriva y compara `hash`** (dentro de `executeRevertPlan`): si el estado del slot cambió entre confirmar y ejecutar (alguien subió/revirtió en el medio), **no ejecuta** y re-muestra la página de confirmación con el plan fresco y el aviso `El estado del slot cambió desde que viste este plan — revisalo de nuevo`. Fail-closed.
4. **Guard de conversión en curso** (wiring, en `revertExec` antes de ejecutar): si `runs(slot,1)[0]` está `InProgress` o `NotStarted`, lanzar `Error('Hay una conversión en curso — esperá a que termine antes de revertir.')` (cae al PRG como `Error: …`). Ejecutar una compensación mientras el convertidor procesa el landing haría carrera con él.

### D6 — Registro: tabla `intake_revert` + evento de audit + fila «↩️ Reversión» en el timeline

**DDL** (GovernanceStore, mismo estilo; `by_user` porque `BY` es palabra reservada SQL):

```sql
CREATE TABLE IF NOT EXISTS intake_revert (
  id INTEGER PRIMARY KEY,
  slot_id TEXT NOT NULL,
  upload_id INTEGER,               -- ancla a intake_upload.id (#62); NULL si la carga no está en el store
  filename TEXT NOT NULL,
  by_user TEXT NOT NULL,
  at TEXT NOT NULL,                -- ISO-8601
  resumen TEXT NOT NULL,           -- JSON: ClaveAccion[] (el plan ejecutado, con lo reportado-sin-tocar)
  landing_retirado INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_intake_revert_slot ON intake_revert (slot_id, at DESC);
```

```ts
export interface IntakeRevertRow {
  id: number; slotId: string; uploadId?: number; filename: string
  byUser: string; at: string; resumen: ClaveAccion[]; landingRetirado: boolean
}
export interface IntakeRevertStore {
  recordRevert(row: Omit<IntakeRevertRow, 'id'>): Promise<number>
  listReverts(slotId: string, limit: number): Promise<IntakeRevertRow[]>
}
```

- Se registra **al completar la ejecución** (una ejecución fallida a medias no registra: la re-entrada converge y registra al cerrar; el audit sí recibe el intento, ver abajo).
- **Evento de audit** `type:'intake-revert'` se conserva (compat con fase 1) y se extiende: `{ type:'intake-revert', slot, domain, filename, by, uploadId?, claves: <resumen compacto 'K1:rematerializar,K2:vaciar,K3:pisada'>, landingRetirado }`. Los campos de fase 1 (`clave`, `compensada`, `reactivado`) dejan de emitirse — el audit es append-only, lo ya escrito queda legible tal cual.
- **Timeline**: `timeline()` gana un parámetro opcional `reverts?: IntakeRevertRow[]` y renderiza filas `↩️ Reversión` (ts = `at`): `«<filename>» revertida · <by>` + sub con el resumen legible por clave. La **conversión compensatoria** aparece sola como fila ⚙️ normal (es una corrida real del job). `cargasBody` obtiene `reverts` vía `SlotCargas.reverts` (nuevo campo, fetch tolerante en `cargasPage` como los demás).

### D7 — Idempotencia y re-entrada: por re-derivación, no por bandera

- El plan se **re-deriva en cada ejecución** (D5.3): tras una ejecución exitosa, la copia de C ya no está en `_processed/` ni en el landing → el plan re-derivado queda sin acciones (`ejecutable:false`) y la página dice que no hay nada que revertir. Re-postear `revert-exec` con el hash viejo → mismatch → página fresca. Nada se ejecuta dos veces.
- Tras un fallo a mitad de secuencia, el orden de D4 garantiza convergencia: cada paso es overwrite-idempotente (`copy`) o tolerante a ausencia (`remove` 404 no-op), y C no se remueve antes de asegurar su compensación. Copias duplicadas en `_retirado/` por re-intentos (prefijo `Date.now()`) son respaldo redundante, no corrupción — se acepta.
- El manifiesto de reversión (D8) tiene **nombre determinístico por clave** → re-escribirlo es overwrite del mismo contenido lógico.

### D8 — El DELETE lo ejecuta el convertidor: manifiesto de reversión + capacidad declarada `revert_delete`

Vergis jamás hace DML sobre las tablas del slot (no conoce tabla ni columna; el warehouse es del convertidor — misma separación de #95: *Vergis declara y propaga; el convertidor, único que toca el contenido, ejecuta*). El canal es el landing, con la convención sidecar que el SJD actual ya ignora (archivos `.meta.json` sueltos son inocuos — `intake-onelake.ts` 75; el filtro `isSidecarName` además los oculta en la UI).

**Contrato (extensión del contrato de ingesta, misma familia que el marcador `[delta]` de #62):**

- **Archivo**: `<landing>/_revert_<clave>.meta.json` (determinístico por clave; `<clave>` es un segmento de path ya validado por existir como directorio de `_processed/`).
- **Contenido**:
  ```json
  { "revert": { "clave": "W28" }, "slot": "saldos", "filename": "saldos VH WK28.xlsx", "by": "steward@gh.cl", "at": "2026-08-06T18:00:00Z" }
  ```
- **Obligación del convertidor** (instancia, fuera de este repo): al inicio de la corrida, por cada `_revert_*.meta.json` del landing: DELETE de la clave en sus tablas, línea de log `[revert] ✔ clave <clave> eliminada: <N> filas` (familia de `[delta]`/`✔`), y eliminación del manifiesto. **Conjetura etiquetada:** desde este repo no puede verificarse si el pipeline GH lo implementa; por eso el mecanismo entero está **gated por config**:
- **`revert_delete: true`** en el slot (`slots.yaml`) = la instancia DECLARA que su convertidor cumple el contrato. Parse en `intake.ts` → `IntakeSlot.revertDelete?: boolean` (booleano estricto, error de parse si no; ausente = false). **Sin la declaración, Vergis no escribe manifiestos y el caso D3.ii es no-compensable** (fail-closed, sin adivinar).
- Adoptar el contrato en el pipeline GH y encender `revert_delete` es **exclusivo del humano** (terreno de la instancia).

### D9 — Superficies y coordinación de merge

- `timeline(history, runs, limit, diagnostico?, …)` y `cargasBody` ganan parámetros **opcionales y aditivos** (`reverts`, `revertFormOf?: (h: IntakeUploadEvent) => string` — `cargasBody` construye el form del botón porque conoce `action`/`token`/`slot`). **#99 (ola A) también agrega parámetros opcionales a `timeline`/`cargasBody`** (`diseno-gh99.md` T5): si al integrar ya está mergeado, el conflicto es textual y se resuelve conservando AMBOS juegos de parámetros; ninguno depende del otro.
- **No tocar territorio de #99** (`packages/capabilities/src/run-logs.ts`, `server/admin-corrida.ts`, `logs:` de procesos) **ni de #105** (proyección `ingestion_run` / frescura): este diseño no crea proyecciones ni páginas de corrida.
- La guía `¿Cómo funciona el ciclo de una carga?` (`admin-cargas.ts` 260–262) se actualiza mencionando la acción por carga y su confirmación.

---

## Territorio (cruzado contra las tareas)

| Archivo | Qué se toca | Tarea |
|---|---|---|
| `packages/capabilities/src/intake.ts` | `IntakeSlot.revertDelete?` + parse `revert_delete` en `parseSlot` (~línea 155, junto a `log`) | T1 |
| `packages/capabilities/src/intake-revert.ts` | **NUEVO** — motor: tipos, `deriveRevertPlan`, `executeRevertPlan`, nombre del manifiesto, hash canónico | T2 |
| `packages/capabilities/src/governance-store.ts` | DDL `intake_revert`, `IntakeRevertStore`, implementación en `SqliteGovernanceStore`, `GovernanceStore extends …` | T3 |
| `packages/capabilities/src/index.ts` | exports nuevos | T1–T3 |
| `server/admin-cargas.ts` | `IntakeUploadEvent.id?`; `CargasOps` (quitar `revert?`, sumar `reverts?`/`revertPlan?`/`revertExec?`); `timeline` con `reverts` + filas ↩️; botón por carga vía `revertFormOf`; botón de Procesados → `revert-plan`; render `revertPlanBody` (página de confirmación, puro); guía | T4 |
| `server/admin.ts` | dispatch POST cargas: rama `revert-plan` responde 200 (página), `revert-exec` ejecuta→PRG o re-muestra plan; quitar rama `revert` de fase 1; audit extendido | T4 |
| `server/serve-rls.ts` | wiring: `history` puebla `id`; `reverts`/`revertPlan`/`revertExec` sobre el motor (con guard de conversión en curso y `recordRevert`); quitar el `revert` de fase 1 (886–912) | T5 |
| `tests/intake.test.ts` | parse de `revert_delete` | T1 |
| `tests/intake-revert.test.ts` | **NUEVO** — motor con reader/jobs falsos | T2 |
| `tests/governance-store.test.ts` | `intake_revert` | T3 |
| `tests/admin-cargas.test.ts` | flujo nuevo (los tests de fase 1 370–413 se reescriben; el resto NO se modifica) | T4 |

**Intocables (reglas duras):**

- `server/multipart.ts`; el write-path `createOneLakeIntake` y el `OneLakeReader` de `intake-onelake.ts` (el motor solo los CONSUME); `handleIntake` y el precheck de #62.
- El marcador `[delta] sin cambios en el dato`, la convención `✖`/`✔`/`⚠` del log, y la forma de los eventos de audit YA escritos (append-only: compat de lectura).
- Todo lo de #62: `intake_upload`, `IntakeUploadStore`, backfill, migración — se USA, no se edita (salvo `extends` del store para la sección nueva).
- Territorio de #99 y #105 (D9). El pipeline/SJD de la instancia (fuera del repo).
- No agregar dependencias npm (`node:crypto` es nativo).
- Atención al leer `server/admin.ts`: un safeguard automático a veces corta su lectura — leer por rangos si pasa.

## Orden y tareas — «hecho cuando»

Un solo ejecutor, secuencial T1→T6. Rama sugerida: `feat/intake-revertir-carga-63`. Base: main con #62 mergeado (verificar `git log --oneline` que el commit de #62 esté; si no, rebasar sobre su rama).

**T1 — Config del slot (`intake.ts`)**
*Hecho cuando:* `npx vitest run tests/intake.test.ts` verde con casos: `revert_delete: true` → `slot.revertDelete === true`; ausente → `undefined`; `revert_delete: 'si'` → error de parse nombrando el slot.

**T2 — Motor (`intake-revert.ts`)**
Arnés: reader falso en memoria (mapa ruta→{bytes,mtime}; `list` filtra por prefijo; `copy`/`remove` mutan el mapa) + jobs falso (`runNow` espía). Fixture base: `_processed/W28/v1.xlsx` (viejo) + `_processed/W28/saldos.xlsx` (sha de la carga, vigente) + `_processed/W29/saldos.xlsx` (mismo nombre, sha DISTINTO, vigente) + landing con `saldos.xlsx` (sha de la carga) y su sidecar.
*Hecho cuando:* `npx vitest run tests/intake-revert.test.ts` verde cubriendo: **(a)** plan por uploadId: W28 → `rematerializar` con `previa: v1.xlsx`; W29 → `pisada` (sha distinto = sobreescrito); landing incluido; `ejecutable:true`; **(b)** ejecución (i): v1.xlsx (y sidecar si existe) copiado al landing ANTES del remove de saldos.xlsx; saldos.xlsx en `_retirado/` con `revertido` en el nombre; `runNow` UNA vez; W29 intacto; **(c)** sin versión previa y `revertDelete:true` → manifiesto `_revert_W28.meta.json` en el landing con `revert.clave === 'W28'`, archivo a `_retirado/`, `runNow`; **(d)** sin versión previa y sin `revertDelete` → `no-compensable`, NADA se mueve de esa clave, sin manifiesto; **(e)** hash mismatch: derivar, mutar el reader (nueva carga en W28), ejecutar con el hash viejo → `{ok:false, plan}` fresco y NADA mutado; **(f)** re-entrada: tras ejecutar, re-derivar → `ejecutable:false`; **(g)** plan por `archivedPath` (Procesados) equivale al de la clave de esa ruta; **(h)** archivo bajo `_processed/` sin dir de clave → `sin-clave`, no se toca; **(i)** sidecar ausente en `_processed/` no aborta la re-materialización.

**T3 — Store (`governance-store.ts`)**
*Hecho cuando:* `npx vitest run tests/governance-store.test.ts` verde con: `recordRevert` devuelve id; `listReverts` recientes primero con `limit` y `resumen` roundtrip (JSON); reabrir desde archivo conserva filas; slot ajeno no aparece.

**T4 — Server: UI + acciones (`admin-cargas.ts`, `admin.ts`)**
*Hecho cuando:* `npx vitest run tests/admin-cargas.test.ts` verde con (arnés existente `mkAdmin`/`mockReq`; `ops()` gana `reverts`/`revertPlan`/`revertExec` mock): **(a)** GET consola: fila 📤 con `id` y `sha256` trae `>Revertir esta carga<`; sin `id` o sin sha, no; **(b)** POST `revert-plan` → 200 (NO redirect) y el HTML contiene los textos sellados de D5 según el plan mockeado (rematerializar / VACÍA / no-compensable / pisada); plan `ejecutable:false` → sin form de exec; **(c)** POST `revert-exec` con `revertExec` → `{ok:true}` → 303 con `Reversión ejecutada` en el msg, y audit `intake-revert` con `claves`; **(d)** `revertExec` → `{ok:false, plan}` → 200 con `El estado del slot cambió`; **(e)** traversal / ruta fuera de `_processed/` en `archivo` → rechazado sin llegar a ops (guard existente reutilizado); **(f)** no-steward → 403; **(g)** timeline con `reverts` renderiza `↩️ Reversión` con filename y resumen; **(h)** botón de Procesados posta `accion=revert-plan`; **(i)** los tests previos NO tocados siguen verdes.

**T5 — Wiring (`serve-rls.ts`)**
`history` puebla `id`; `reverts` → `govStore.listReverts`; `revertPlan`/`revertExec` → motor con `{reader, jobs, uploads: govStore}`; en `revertExec`: guard de corrida `InProgress|NotStarted` (vía `jobStatus`, tolerante: si el status falla, NO bloquear — conjetura de disponibilidad del motor, mismo trato tolerante del resto del wiring) y `recordRevert` + audit al completar; eliminar el `revert` de fase 1.
*Hecho cuando:* `npm run typecheck` && `npm run build` verdes y `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (esos tests no cablean Fabric: las ops nuevas quedan sin ejercitar ahí — el juez funcional es T2/T4).

**T6 — Juez completo**
*Hecho cuando:* `npm run typecheck && npm test && npm run build` — los tres verdes en el árbol integrado.

**Juez:** los tres gates + los vitest nombrados (OneLake/Fabric/stores SIEMPRE falsos en CI, patrón ya existente). **Gate manual diferido (declarado):** la conducta contra motor VIVO — layout `_processed/` real, re-materialización efectiva, y el DELETE del manifiesto (que además exige implementar el contrato D8 en el pipeline GH y declarar `revert_delete`) — NO es observable en CI; queda como hand-off humano (skill `mira-ops`), igual que el deploy. Hasta ese gate, D8 opera solo en instancias que lo declaren.

## Reparto de autoridad

- **Decide el ejecutor:** nombres de helpers privados, detalle de render dentro de la pauta, organización interna de tests, forma exacta del JSON canónico del hash (mientras sea determinística y esté testeada).
- **Consulta antes:** cualquier cambio a la forma del manifiesto D8, a los textos sellados de D5, al evento de audit, o a los intocables.
- **Exclusivo del humano:** implementar D8 en el pipeline de la instancia, declarar `revert_delete` en `slots.yaml` de GH, deploy a la VM.

## Riesgos

1. **El contrato D8 no está implementado en la instancia** — mitigado: gated por `revert_delete` (fail-closed); sin declaración el caso (ii) se reporta sin tocarse. Si la declaración fuera falsa, los manifiestos quedarían inertes en el landing (invisibles a la UI); riesgo aceptado y documentado — detectarlo es materia del gate manual.
2. **Conjeturas del layout** (sidecars archivados, multi-clave, overwrite por nombre) — mitigadas por diseño: sha como identidad, best-effort en sidecars, plan robusto a N apariciones; etiquetadas arriba.
3. **Carrera con una conversión en curso** — guard de D5.4 (best-effort: la ventana entre el check y la ejecución existe; el hash del plan acota el daño a lo planeado, jamás a claves ajenas).
4. **Conflicto de merge con #99 en `admin-cargas.ts`** — parámetros aditivos ambos; resolución declarada en D9.
5. **Costo de `readBytes` en la derivación** — acotado a candidatos por basename (unidades) con timeout de 30 s por request ya presente en el reader; la derivación solo corre al pedir el plan, nunca en el render de la consola.
6. **Cargas pre-#62 sin sha** — sin botón por carga (honesto); el camino por archivo de Procesados las cubre, con el `findUploadBySha` devolviendo null y `uploadId` ausente en el registro.
7. **`_retirado/` acumula copias** — por diseño (respaldo barato, nunca se borra); sin cota pre-launch, igual que fase 1.

---

*Diseño Fable (ww:wingcoding) · cluster 002 · 2026-08-06 · fuentes: código de main verificado en las rutas citadas + `diseno-gh62.md` (base asumida); lo no verificable desde el repo está etiquetado conjetura (mapa, D8).*
