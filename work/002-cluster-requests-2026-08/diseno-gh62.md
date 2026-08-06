# Diseño #62 — Dedup por hash de contenido + señal «delta neto cero» (TX-06)

**Issue:** [Gegolabs/vergis#62] `feat(intake): detectar la re-carga de un archivo idéntico — dedup por hash de contenido + señal «delta neto cero» (TX-06)`
**Rol de este documento:** contrato de delegación (ww:wingcoding). Lo ejecuta un agente Opus en frío: todo lo necesario está aquí o referenciado por ruta exacta.
**Repo:** `/Users/cesar/wworkspace/productos/vergis` (monorepo TS; workspaces `packages/*` + `server/` + `tests/` vitest).
**Gates:** `npm run typecheck` && `npm test` && `npm run build`. Producto pre-launch: rige el criterio de excelencia, sin scope creep.

---

## ¿Qué pide el issue?

Dos capas complementarias para que una re-carga sin efecto sea VISIBLE:

1. **Hash de contenido al recibir** (SHA-256 de los bytes): si es idéntico a uno ya procesado del slot → **avisar sin bloquear** («idéntico a "X", procesado el ⟨ts⟩; re-procesarlo no cambiará el dato. ¿Continuar?») + tag «duplicado de ⟨X⟩» en Actividad. El **nombre no participa** (las copias llegan como `... (1) (1).xlsx`). Hash **persistido junto a cada carga**; **retro-calculable** para `_processed/`.
2. **«Delta neto cero» al cierre de la conversión**: el pipeline sabe qué DELETE+INSERT hizo — si el dato quedó igual, señalarlo («✓ Listo · sin cambios en el dato»). Cubre hash distinto / dato igual (re-export con otro orden interno).

**No bloquear jamás:** re-procesar idéntico es legítimo (Reactivar / re-materialización).

## ¿Qué existe ya en main? (estado verificado, no partir de cero)

El commit `9613aae` (release 0.7.0, CHANGELOG líneas 164–177) implementó una **fase 1** de #62. Verificado contra el código el 2026-08-06:

| Pieza | Dónde | Estado |
|---|---|---|
| SHA-256 de los bytes al subir | `server/admin.ts` `handleIntake`, línea ~482 (`createHash('sha256').update(u.bytes)`) | ✅ existe |
| Detección de duplicado | `admin.ts` ~468–472: `dupDe()` busca en `deps.cargas.history(slot, 500)` | ✅ existe, pero contra el **audit log** (ver brechas) |
| Aviso sin bloquear | `admin.ts` ~491: aviso **post-hoc** en el mensaje del redirect PRG | ⚠ parcial: avisa DESPUÉS de subir y de disparar la conversión — no hay «¿Continuar?» |
| Tag en Actividad | `server/admin-cargas.ts` línea ~158: fila de Carga con `⚠ contenido idéntico a <dupOf> — re-procesarlo no cambia el dato`; `IntakeUploadEvent.sha256?`/`dupOf?` (líneas 29–31) | ✅ existe |
| Hash persistido | En el evento `type:'intake'` del audit log JSONL (`${OUT}/admin-audit.log`, `AppendOnlyLog` con `retain:false` — `server/serve-rls.ts` ~800) | ⚠ existe, pero NO en el GovernanceStore |
| Badge «sin cambios en el dato» | `admin-cargas.ts` ~204: `logText.includes('[delta] sin cambios en el dato')` sobre la corrida `Completed` más reciente → sufijo en «Última conversión» | ✅ existe (solo ahí; no en el timeline) |
| Tests | `tests/admin-cargas.test.ts` ~327–365: dup detecta / contenido nuevo no / render del tag / badge delta | ✅ existen |

### ¿Qué brechas cierra este diseño?

1. **El hash no vive junto al registro de carga en un store** — vive en un archivo JSONL que `history()` (`serve-rls.ts` ~836–852) reparsea entero en cada consulta con ventana de 500 eventos; sin índice; el `AppendOnlyLog` es evidencia de auditoría, no registro consultable. El issue pide GovernanceStore.
2. **No hay retro-cálculo para `_processed/`** — todo lo procesado ANTES de 0.7.0 es invisible al dedup. El incidente que motivó TX-06 (Finanzas 09→12-jul, PI-07 13-jul) es exactamente de esa época.
3. **El «¿Continuar?» no existe** — el usuario se entera del duplicado cuando el archivo ya aterrizó y la conversión ya corre.
4. **El badge delta-cero no aparece en la fila «⚙️ Conversión» del timeline de Actividad** — solo en la línea «Última conversión».

---

## ¿Cómo es la arquitectura actual del flujo? (mapa verificado)

- **Subida:** form multipart (`uploadForm`, `admin.ts` ~839–847: `<input type="file" name="file" multiple>` + campos `meta_*` + `_csrf`) → `POST /admin/dominio/<dom>/intake/<slot>` → `handleIntake` (`admin.ts` 416–493): `readMultipart` (`server/multipart.ts`) → valida lote completo (`validateUpload`, `validateMeta` de `packages/capabilities/src/intake.ts`) → sha256 + dupDe → `deps.intake.put()` (sidecar antes que archivo, `packages/capabilities/src/intake-onelake.ts`) → `runNow` UNA vez por lote → `deps.audit({type:'intake', …, sha256, dupOf?})` → redirect PRG con aviso. El mismo form se usa en la consola de **Cargas** (~868) y en **Frescura** (~977, ~1007).
- **Registro de cada carga:** SOLO el audit log (`AppendOnlyLog`, `packages/botler/src/log.ts` — `append()` agrega `ts`/`seq`/`prevHash` y escribe una línea JSON). El GovernanceStore (`packages/capabilities/src/governance-store.ts`, SQLite sql.js sobre volumen persistente, `persistSqliteDb` atómico vía tmp+rename) hoy NO tiene tabla de cargas.
- **Consola de Cargas:** `server/admin-cargas.ts` (módulo puro datos→HTML) + `CargasOps` implementado en el wiring `serve-rls.ts` ~833–914 (`history`/`runs`/`log`/`landing`/`archived`/`rerun`/`retire`/`restore`/`revert`). `archived` lista `<padre-del-landing>/_processed` **recursivo**; el layout `_processed/<clave>/<archivo>` es el ledger carga→clave que #63 explota.
- **Conversión:** el convertidor (SJD/pipeline de la INSTANCIA, fuera de este repo — ADR-001: Vergis no parsea planillas) hace DELETE+INSERT por clave y escribe su log en `Files/code/_ingest_log.txt` (`slotLogPath`). Vergis solo ve: (a) ese log (líneas `[ingest] ▶/⚠/✔/✖` y el marcador `[delta] sin cambios en el dato`), y (b) el estado del job vía `jobs/instances` (`createFabricJobStatus`). **No existen contadores estructurados de filas del lado Vergis** — verificado: la única cifra visible es texto del log (`✔ DONE commit W28: 7626 filas`).
- **OneLakeReader** (`intake-onelake.ts` ~98–178) ya ofrece `readBytes`/`list`/`copy`/`remove` — todo lo que el retro-cálculo necesita.

---

## Decisiones selladas

### D1 — El registro de carga se convierte en tabla de primera clase del GovernanceStore: `intake_upload`

El registro de cargas es estado de gobierno («quién/cuándo/qué entró»), exactamente lo que el GovernanceStore declara ser (su docstring, `governance-store.ts` 28–38). El audit log es **evidencia encadenada**, no índice de consulta: reparsearlo con ventana de 500 es el statu quo, no el diseño correcto. Criterio de excelencia: si nada existiera, el registro viviría en el store — se mueve ahí.

**Esquema exacto** (DDL, mismo estilo de las demás tablas del store):

```sql
CREATE TABLE IF NOT EXISTS intake_upload (
  id INTEGER PRIMARY KEY,
  slot_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,            -- hex 64 minúsculas: identidad del contenido (el nombre NO participa)
  bytes INTEGER NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,       -- ISO-8601
  ok INTEGER NOT NULL DEFAULT 1,   -- 0 = subida rechazada (validación/metadata): el timeline la muestra igual
  error TEXT,                      -- motivo del rechazo (ok=0)
  triggered INTEGER NOT NULL DEFAULT 0,
  origen TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'retro' (indexado retroactivo de _processed/, D3)
  dup_of INTEGER                   -- id de la carga original si el contenido es idéntico (D5)
);
CREATE INDEX IF NOT EXISTS idx_intake_upload_sha ON intake_upload (slot_id, sha256);
CREATE INDEX IF NOT EXISTS idx_intake_upload_slot_ts ON intake_upload (slot_id, uploaded_at DESC);
```

**Interfaz** (nueva, compuesta en `GovernanceStore` igual que `MirandaStore` etc.):

```ts
export interface IntakeUploadRow {
  id: number; slotId: string; filename: string; sha256: string; bytes: number
  uploadedBy?: string; uploadedAt: string; ok: boolean; error?: string
  triggered: boolean; origen: 'upload' | 'retro'; dupOfId?: number
}
export interface IntakeUploadStore {
  /** Registra una carga (o su rechazo). Devuelve el id asignado. */
  recordUpload(row: Omit<IntakeUploadRow, 'id'>): Promise<number>
  /** La carga ORIGINAL (ok=1) con ese contenido en el slot: la fila más antigua con ese sha. */
  findUploadBySha(slotId: string, sha256: string): Promise<IntakeUploadRow | null>
  /** Cargas del slot, recientes primero. */
  listUploads(slotId: string, limit: number): Promise<IntakeUploadRow[]>
  /** ¿El indexado retroactivo de _processed/ del slot ya corrió? (D3) */
  intakeBackfillDone(slotId: string): Promise<boolean>
  markIntakeBackfillDone(slotId: string, files: number, errores: number): Promise<void>
}
```

La marca de backfill vive en su tabla propia (no en `platform_setting` — es estado del intake, no configuración de plataforma):

```sql
CREATE TABLE IF NOT EXISTS intake_backfill (
  slot_id TEXT PRIMARY KEY, done_at TEXT NOT NULL, files INTEGER NOT NULL, errores INTEGER NOT NULL
);
```

**Consecuencias selladas:**

- `handleIntake` registra en el store **cada archivo del lote** (después del `put` exitoso, `ok=1`; los rechazos de validación/metadata se registran `ok=0` con `error`) y el dedup consulta `findUploadBySha` — se elimina `dupDe()` sobre `history(500)`.
- El chequeo es **check-then-insert por archivo en orden**: dos archivos idénticos dentro del MISMO lote también se detectan (el segundo ve al primero ya insertado).
- `CargasOps.history` del wiring (`serve-rls.ts`) pasa a leer del store (`listUploads` → mapear a `IntakeUploadEvent`), no del JSONL. La forma de `IntakeUploadEvent` (`admin-cargas.ts` 21–32) **no cambia**.
- El **audit log sigue recibiendo el evento `type:'intake'` exactamente igual** (con `sha256` y `dupOf`): la cadena de evidencia no se toca; solo deja de ser fuente de consulta.
- **Migración one-shot** en el wiring: al construir `CargasOps`, si `intake_upload` está vacía y `${OUT}/admin-audit.log` existe, importar sus eventos `type:'intake'` (con `origen:'upload'`, `dup_of` NULL — el string `dupOf` viejo no se re-resuelve a id, solo servía de aviso). Idempotente por la condición «tabla vacía»; así el timeline no pierde historia al cambiar de fuente.
- **Convivencia con #63 (no diseñar #63, dejarlo listo):** `intake_upload.id` + `sha256` son el ancla de identidad que el ledger carga→claves de #63 referenciará (misma familia: hash = identidad · delta neto = semántica · rollback = reversibilidad). Este diseño NO crea la tabla de claves ni columnas de delta: solo garantiza un id estable y persistente por carga.

### D2 — El «¿Continuar?» es un pre-check en el cliente ANTES de subir; el server mantiene la red post-hoc

El flujo real es un form POST full-page (PRG): preguntar «¿Continuar?» después de `put` + `runNow` sería teatro — la conversión ya corre. El punto honesto para preguntar es **antes de que los bytes salgan del browser**, y el browser puede calcular el mismo SHA-256 sin subir nada (`crypto.subtle.digest`), de modo que el pre-check viaja con hashes, no con archivos.

**Sellado:**

1. **Nuevo endpoint** `POST /admin/dominio/<dom>/intake/<slot>/precheck` (en `admin.ts`, junto a la ruta `intake` existente, mismo gate de steward del dominio y mismo CSRF). Body `application/x-www-form-urlencoded`: `_csrf` + `shas` (hex de 64, separados por coma; se ignoran los malformados). Respuesta `200 application/json`:
   ```json
   { "dups": [ { "sha256": "…", "filename": "saldos VH WK28.xlsx", "uploadedAt": "2026-07-13T16:17:42Z", "origen": "upload" } ] }
   ```
   Consulta `findUploadBySha` por cada sha. Sin store inyectado → `{ "dups": [] }` (fail-safe).
2. **`uploadForm` gana un handler de submit** (JS inline, cero librerías — coherente con la casa: sin supply-chain): intercepta el submit, para cada archivo del input calcula `crypto.subtle.digest('SHA-256', await file.arrayBuffer())`, llama al precheck con `fetch`, y si hay duplicados muestra `confirm()` con el texto del issue:
   > «A (1) (1).xlsx» es idéntico a «saldos VH WK28.xlsx», procesado el 2026-07-13 16:17 UTC; re-procesarlo no cambiará el dato. ¿Continuar?
   Aceptar → submit normal; cancelar → no se sube nada. `confirm()` nativo es la pauta ya usada por la consola (`postForm`, `admin-cargas.ts` ~180).
3. **Fail-safe declarado, nunca bloquear:** si `crypto.subtle` no existe, el `fetch` falla o demora (timeout 3 s vía `AbortSignal.timeout`), el form se envía SIN aviso previo. El server **siempre** recalcula el sha con sus propios bytes y registra `dup_of` (no se confía en el cliente); el aviso post-hoc del redirect (ya existente, `admin.ts` ~491) queda como red de seguridad. El precheck es consultivo: jamás un 4xx por duplicado.
4. Nota etiquetada (conjetura operacional): `crypto.subtle` exige secure context; el admin corre tras oauth2-proxy/Caddy con TLS en la VM y en `localhost` en dev — ambos secure contexts. No re-verificado contra el despliegue desde este repo; por eso el punto 3 existe y el camino sin SubtleCrypto queda funcional e idéntico al actual.

### D3 — Retro-cálculo de `_processed/`: lazy, una sola vez por slot, en background

Alternativas: (a) comando/migración manual, (b) lazy al primer check. Sellado: **(b)**. Un comando es un paso de runbook que alguien olvida — el sistema debe converger solo. El costo (bajar y hashear N archivos ≤25 MB) se paga una vez y fuera del camino crítico.

- **Disparo:** en el wiring (`serve-rls.ts`), el primer `precheck` o el primer upload de un slot cuyo `intakeBackfillDone` sea falso lanza el indexado **sin `await`** (fire-and-forget): ni la subida ni el precheck esperan.
- **Qué hace:** `reader.list(target, '<padre>/_processed', {recursive:true})` (mismo cálculo de `<padre>` que `archived`, `serve-rls.ts` ~834) → por cada entrada no-directorio y no-sidecar (`isSidecarName`): `readBytes` → sha256 → `recordUpload` con `origen:'retro'`, `uploadedAt` = `lastModified` de la entrada, `uploadedBy:'(retro: _processed)'`, `ok:1`, `triggered:0`. Antes de insertar, saltar si ya existe una fila del slot con ese `sha256` y ese `filename` (idempotencia frente a re-lanzamientos y a la migración D1).
- **Cierre:** al terminar la pasada, `markIntakeBackfillDone(slot, files, errores)` + evento de audit `{type:'intake-hash-backfill', slot, files, errores}`. Un archivo ilegible no aborta el resto: se cuenta en `errores`. Si la pasada entera revienta (p. ej. el `list` falla), NO se marca — se reintenta en el próximo disparo.
- **Honestidad transitoria:** mientras el backfill no termina, el dedup solo ve lo ya indexado; el aviso es best-effort la primera vez. Es la degradación correcta: preferible a bloquear la subida hasta hashear el histórico.
- Las filas `origen:'retro'` **no** aparecen en el timeline de Actividad (`history` filtra `origen='upload'`): son índice de identidad, no eventos de carga vividos. Sí participan del dedup y del precheck (es su razón de ser: «idéntico a X **procesado** el ts»).

### D4 — «Delta neto cero»: definición operativa y dónde se muestra

**Con qué cuenta el pipeline (verificado):** el convertidor es terreno de la instancia (ADR-001) y lo ÚNICO estructurado que Vergis recibe de la conversión es el log del slot y el estado del job. No hay contadores de filas del lado Vergis. Por tanto la señal viaja por el canal que ya existe: **el log**.

**Definición operativa sellada (contrato de ingesta, convención del log):** el convertidor ejecuta DELETE+INSERT por clave, así que conoce, por cada clave tocada, las filas borradas y las insertadas. Cuando **toda clave tocada** queda con contenido idéntico (mismo conteo y mismas filas — comparación orden-independiente, p. ej. hash de las filas normalizadas y ordenadas; el orden interno del archivo y su metadata NO cuentan), emite como línea del log, antes del `✔ DONE`, el marcador **literal**:

```
[delta] sin cambios en el dato
```

Vergis consume el marcador tal cual (`includes`, ya implementado). La emisión es responsabilidad del pipeline de la instancia — **conjetura etiquetada:** desde este repo no puede verificarse si el pipeline GH ya lo emite; el consumo es fail-safe (sin marcador no hay badge, nada se rompe). El texto del marcador es INTOCABLE: ya está en producción en `admin-cargas.ts` ~204, sus tests y el CHANGELOG 0.7.0.

**Dónde se muestra (sellado):**

1. Línea «Última conversión»: `✓ Listo · sin cambios en el dato` — ya existe (`admin-cargas.ts` ~204, ~222). Se conserva tal cual.
2. **NUEVO — fila «⚙️ Conversión» del timeline de Actividad:** el mismo sufijo `· sin cambios en el dato`, SOLO en la corrida más reciente (`runs[0]`) cuando está `Completed` y el log no es añejo (mtime del log ≥ inicio de la corrida — misma disciplina que el diagnóstico `✖` de #85/#86: el log pertenece a la última conversión; atribuirlo a corridas viejas sería mentir). Implementación: `timeline()` recibe un flag `sinCambios?: boolean` (como hoy recibe `diagnostico`) y lo aplica en `i === 0 && r.status === 'Completed'`; el flag lo computa `cargasBody`, que ya calcula `sinCambios` y `logAñejo`.

El registro **persistente** del delta por carga/clave es materia del ledger de #63 — aquí la señal es de la corrida, no se persiste.

### D5 — Tag «duplicado de X» en Actividad: esquema

- **Persistencia:** `intake_upload.dup_of` = id de la fila original (la más antigua `ok=1` con el mismo sha en el slot). Fuente única de verdad relacional.
- **Evento de audit:** conserva el campo `dupOf` string legible ya en producción: `"<filename> · <YYYY-MM-DD HH:MM> UTC"` (formato de `dupDe`, `admin.ts` ~471). Compatibilidad de lectura con lo ya escrito; no se re-formatea.
- **Render:** sin cambio — `IntakeUploadEvent.dupOf?: string` y la fila `⚠ contenido idéntico a <dupOf> — re-procesarlo no cambia el dato` (`admin-cargas.ts` ~158). `history()` compone el string resolviendo `dup_of → fila original`; si la original es `origen:'retro'`, el label dice `"<filename> · procesado el <fecha>"` (es lo único que se sabe de ella).
- **Mensaje del precheck y del aviso post-hoc:** mismo léxico del issue («idéntico a "X", procesado el ⟨ts⟩; re-procesarlo no cambiará el dato»).

### D6 — Inyección: `AdminDeps.intakeUploads?: IntakeUploadStore`

`handleIntake` y la ruta precheck reciben el store por `AdminDeps` (opcional como todo lo demás del intake; sin él, dedup y precheck degradan a no-op y el flujo queda como el actual — los tests unitarios existentes que construyen `createAdmin` sin store siguen pasando por diseño, aunque los de dedup se actualizan para inyectarlo). En `serve-rls.ts` se pasa `govStore` (ya está en scope del wiring, ~816).

---

## Territorio (cruzado contra las tareas)

| Archivo | Qué se toca |
|---|---|
| `packages/capabilities/src/governance-store.ts` | DDL `intake_upload` + `intake_backfill`, interfaz `IntakeUploadStore`, implementación en `SqliteGovernanceStore`, `GovernanceStore extends …` |
| `packages/capabilities/src/index.ts` | exportar `IntakeUploadStore`, `IntakeUploadRow` |
| `server/admin.ts` | `AdminDeps.intakeUploads?`; `handleIntake` (dedup desde store, registro por archivo, eliminación de `dupDe/history(500)`); ruta `POST …/intake/<slot>/precheck`; JS de pre-check en `uploadForm` |
| `server/admin-cargas.ts` | `timeline()` con flag `sinCambios` para `runs[0]`; `cargasBody` se lo pasa |
| `server/serve-rls.ts` | wiring: `intakeUploads: govStore`; `history` desde `listUploads`; migración one-shot desde el audit log; disparo lazy del backfill (D3) |
| `tests/governance-store.test.ts` | tests del store nuevo |
| `tests/admin-cargas.test.ts` | tests de dedup contra store, precheck, timeline delta; actualización del arnés `mkAdmin` (inyectar `SqliteGovernanceStore.open(null)`) |

**Intocables (reglas duras):**

- `server/multipart.ts`, `packages/capabilities/src/intake.ts`, el write-path de `intake-onelake.ts` (`createOneLakeIntake`) — el diseño solo CONSUME `OneLakeReader`.
- El **marcador literal** `[delta] sin cambios en el dato` y el prefijo/convención del log de ingesta (`✖`/`✔`/`⚠`) — contrato con el pipeline de la instancia, ya en producción.
- La **forma del evento de audit** `type:'intake'` (campos y formato de `dupOf`) — compat con lo ya escrito en `admin-audit.log`.
- El pipeline/SJD de la instancia (fuera de este repo). Nada de este diseño lo edita.
- No agregar dependencias npm (SubtleCrypto y `node:crypto` son nativos).
- Atención al leer `server/admin.ts`: un safeguard automático a veces corta su lectura — leer por rangos si pasa.

## Orden y tareas — «hecho cuando»

Un solo ejecutor, secuencial (H1 → H2 → H3 → H4). Rama sugerida: `feat/intake-dedup-store-62`.

**H1 — Store (`packages/capabilities`)**
Tabla + índices + `IntakeUploadStore` en `SqliteGovernanceStore` (mismo patrón sync-SQL + `this.persist()` de las demás secciones) + exports.
*Hecho cuando:* `npx vitest run tests/governance-store.test.ts` verde con tests nuevos: `recordUpload` devuelve id creciente; `findUploadBySha` devuelve la fila **más antigua ok=1** del slot (y `null` para sha desconocido u otro slot); `listUploads` recientes primero con `limit`; backfill done/mark idempotente; reabrir el store desde archivo (usar `file` temporal, no `null`) conserva las filas.

**H2 — Server: dedup desde store + precheck (`server/admin.ts`, `server/serve-rls.ts`)**
`AdminDeps.intakeUploads?`; `handleIntake`: por archivo, sha → `findUploadBySha` → `recordUpload` (con `dup_of` si aplica) → audit igual que hoy; rechazos registrados `ok=0`; ruta precheck; wiring: `history` desde store + migración one-shot + backfill lazy.
*Hecho cuando:* en `tests/admin-cargas.test.ts`: **(a) mismo byte-a-byte detecta** — subir bytes X, volver a subir X con **nombre distinto** → segundo evento con `dupOf` que contiene el filename y ts del primero, y fila en store con `dup_of` = id del primero; **(b) contenido distinto no detecta** — bytes Y → sin `dupOf`; **(c) dup contra fila `origen:'retro'`** detecta y el label dice «procesado el»; **(d) dup interno del lote** (dos files idénticos en un POST multipart) detecta; **(e) precheck** con sha duplicado responde JSON con `filename`/`uploadedAt`, sha desconocido responde `dups:[]`, CSRF inválido → 403; **(f)** la subida NUNCA es rechazada por duplicado (status 302 siempre).

**H3 — UI: pre-check en el form + badge en timeline (`server/admin.ts`, `server/admin-cargas.ts`)**
JS inline del submit (D2.2–D2.3) y `timeline(…, sinCambios)` (D4.2).
*Hecho cuando:* **(a) delta neto cero señalado** — con log `[ingest] ✔ DONE…\n[delta] sin cambios en el dato` y `runs[0]` `Completed`, el HTML de la consola trae «sin cambios en el dato» tanto en «Última conversión» como en la fila de Conversión del timeline; con log añejo (mtime < inicio) o corrida `Failed`, en ninguna; **(b)** el HTML del form contiene el handler con `crypto.subtle.digest` y el POST al `/precheck` del slot; **(c)** los tests existentes del form (Frescura y Cargas) siguen verdes.

**H4 — Integración y gates**
*Hecho cuando:* `npm run typecheck` && `npm test` && `npm run build` verdes en el árbol integrado.

**Juez:** los tres gates + los tests nombrados arriba (vitest). No hay gate humano ni recurso externo: todo el criterio corre en CI local (OneLake/Fabric se mockean como ya hacen `tests/intake-onelake.test.ts` y `tests/admin-cargas.test.ts`). El deploy a la VM queda fuera (hand-off, skill mira-ops).

## Reparto de autoridad

- **Decide el ejecutor:** nombres de helpers privados, detalles de render/estilo dentro de la pauta existente, organización interna de los tests. Registra en el reporte final.
- **Consulta antes:** cualquier cambio al formato del evento de audit, al marcador `[delta]`, a la forma de `IntakeUploadEvent`, o a los intocables.
- **Exclusivo del humano:** deploy, cambios al pipeline de la instancia, y decidir si el pipeline GH adopta la emisión del marcador (D4 — conjetura etiquetada).

## Riesgos

1. **Backfill sobre archivos grandes/muchos** — mitigado: background, secuencial, timeout DFS de 30 s por request (ya en `OneLakeReader`), marca de done, errores contados sin abortar.
2. **`crypto.subtle` ausente (contexto no seguro)** — degrada al flujo actual con aviso post-hoc; nunca bloquea (D2.3).
3. **Precheck antes de terminar el backfill** — aviso best-effort la primera vez; declarado en D3, el post-hoc cubre.
4. **Doble fuente transitoria (audit log vs store)** — la migración one-shot y el switch de `history` van en el MISMO cambio; el audit log queda write-only.
5. **Crecimiento de `intake_upload`** — cargas semanales, volumen mínimo; sin cota pre-launch. sql.js mantiene la DB en memoria y `persist()` reescribe el archivo entero: mismo perfil que las tablas Miranda ya aceptado.
6. **Tests del arnés `mkAdmin` sin store** — se actualizan inyectando `SqliteGovernanceStore.open(null)`; el store es opcional en `AdminDeps`, así que nada más se rompe.

---

*Diseño Fable (ww:wingcoding) · cluster 002 · 2026-08-06 · fuentes: código de main verificado en las rutas citadas; lo no verificable desde el repo está etiquetado conjetura (D2.4, D4).*
