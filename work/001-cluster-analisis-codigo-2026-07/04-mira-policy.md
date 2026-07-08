# Frente 04 · Mira · Botler · CLI · Policy

**Ámbito:** `packages/mira/src/` (mira 638 LOC, compose, freshness, theme-config, dsl/parse, dsl/validate 516 LOC), `packages/botler/src/` (botler, gate, log, result-cache, types), `packages/cli/src/`, `packages/policy/src/` (binder, clickhouse, entities, fabric 297 LOC, frontend, ir, provider, store), `schema/mira-spec.schema.json`.

---

## Tanda Opus 4.8 — concluida

**Verificado que SÍ está resuelto:** timeout en `capabilityCall` con `AbortController` (botler.ts:138-161), límite de profundidad en compose (`MAX_PIECE_DEPTH=32`, compose.ts:170), contrato `expectRows` en la frontera (mira.ts:535), claves del result-cache particionadas por identidad normalizada (capability+params+user+agent+claims ordenados, sha256 canónico — sin colisiones entre consumidores; result-cache.ts:49-57). **Ningún hallazgo ALTA** — el núcleo de seguridad es sólido.

**1. [MEDIA] · corrección/robustez — `mira.ts:197` (y 182-186)**
Contratos de salida de capabilities de render casteados sin validar (`as {html:string}`, `as {csv:string}`). Si `render-html-piece` devuelve algo sin `html`, queda `undefined` y el backstop de :204 (`html===''`) **no dispara** — la página en blanco con 200 que ese backstop debía impedir.
*Mejora:* `expectString(capability, campo, out)` análogo a `expectRows`, o backstop a `!html`. Esfuerzo **S**.

**2. [MEDIA] · dsl/corrección — `schema/mira-spec.schema.json:71-72` vs `dsl/validate.ts:240,255`**
El schema declara `quality` y `delivery` como objetos opacos y **no menciona `interactions`**. Un spec con `delivery.render: html` (string en vez de lista) pasa el schema y revienta en validate.ts:241 con `renders.some is not a function` (TypeError crudo); `interactions.filters` no-arreglo revienta igual.
*Mejora:* tipar en el schema `delivery.render[]`, `delivery.channels[]`, `interactions.filters[]`, estructura de `quality.freshness` — AJV daría el path exacto. Esfuerzo **M**.

**3. [MEDIA] · corrección/dsl — `dsl/validate.ts` (falta) / `compose.ts:216,300`**
Validaciones que faltan: (a) `kpi.agg.dataset` nunca se contrasta con `data` → typo produce `results['']?.rows ?? []` → KPI muestra 0 sin error; (b) `table.data`/`semaforo.data` sin prefijo `data.` escapan a la recolección de referencias → tabla/semáforo vacíos sin error. El paso 2·bis ya resolvió esto para `distribution`; falta replicarlo.
*Mejora:* replicar para kpi-agg, table y semaforo. Esfuerzo **S/M**.

**4. [MEDIA] · dsl — `dsl/validate.ts:163-175` vs `mira.ts:216`**
El paso 3 (capabilities catalogadas) solo cubre `s.data`; `delivery.channels[].capability` y `render-csv-piece` (format csv) no se validan → typo explota en runtime tarde con `capability-not-found`.
*Mejora:* incluir channels y renders implícitos en el chequeo del catálogo. Esfuerzo **S**.

**5. [MEDIA] · seguridad — `policy/fabric.ts:128-136`**
Divergencia por collation: las comparaciones T-SQL generadas heredan la collation de la base — con la default CI de SQL Server/Fabric el match es **case-insensitive**, más permisivo que el evaluador de referencia (ir.ts:126-130, case-sensitive) y que ClickHouse. Un claim `ventas` vería filas `VENTAS` en Fabric pero no en ClickHouse. Los emuladores no lo modelan → el differential testing no lo detecta.
*Mejora:* `COLLATE Latin1_General_BIN2` explícito, o asertar collation en specialize-time. Esfuerzo **S**.

**6. [MEDIA] · seguridad/corrección — `policy/clickhouse.ts:91-92`, `fabric.ts:132-134` vs `ir.ts:126-129`**
`op: eq` con claim multi-valor diverge de la referencia: el setting es `values.join(',')` y el motor compara contra el string unido (`'a,b'`) — una celda que contenga ese valor con coma **pasa**, mientras la referencia niega. Divergencia allow-más-permisivo. El property test usa celdas sin comas → gap sin cubrir.
*Mejora:* en `settingsForInjections`, si un claim de un predicado `eq` trae >1 valor, inyectar `''` (deny) o rechazar; agregar celdas con coma al generador. Esfuerzo **S**.

**7. [MEDIA] · robustez — `policy/clickhouse.ts:106-107`**
Asimetría con Fabric: el enforcement ClickHouse es un `CREATE ROW POLICY` pelado — sin `OR REPLACE`/`IF NOT EXISTS` y sin `teardownSQL` (Fabric trae setup idempotente + teardown). Re-especializar la misma tabla falla o exige limpieza manual.
*Mejora:* `CREATE OR REPLACE ROW POLICY` + `teardownSQL` simétrico. Esfuerzo **S**.

**8. [MEDIA] · seguridad — `policy/store.ts:54-81`, `entities.ts:135-184`**
Entradas duplicadas de `dataset` en el policy store → last-wins silencioso (`out.set`). Un duplicado accidental con `grant: all` **pisa la RLS de la tabla sin ruido**. `entities.ts` rechaza entidad duplicada (130) pero no dataset duplicado.
*Mejora:* rechazar `dataset` repetido en ambas formas. Esfuerzo **S**.

**9. [MEDIA] · seguridad (defensa en profundidad) — `botler/gate.ts:33-37`**
La confianza en `X-Forwarded-Groups`/`X-Forwarded-Email` es absoluta y sin verificación: si el server queda expuesto sin oauth2-proxy delante (misconfig, puerto directo), cualquier cliente fabrica sus claims. Supuesto de deploy documentado, pero sin defensa en código.
*Mejora:* shared-secret (cabecera firmada por el proxy) o binding al socket del proxy, fail-closed si falta. Esfuerzo **M**.

**10. [MEDIA] · robustez/eficiencia — `mira.ts:167-168`**
Con `interactions.filters`, se materializan al HTML **todos** los datasets recuperados — incluido el del watermark de otra página y las fuentes de controles — no solo los que la pieza/filtros usan; y `totalRows` los cuenta contra el tope. Misma identidad (no cruza RLS), pero infla el documento.
*Mejora:* materializar solo los datasets referenciados por `filters` + la pieza activa. Esfuerzo **S**.

**11. [BAJA] · dsl — `dsl/validate.ts:412-421`** — `controls[].source` valida el dataset pero no el campo contra `shape.fields` (los filters sí). Typo → control sin opciones en silencio. **S**

**12. [BAJA] · corrección — `freshness.ts:51-54`** — El comentario dice «el de mayor antigüedad» pero el reduce usa exceso relativo; con `max_age` heterogéneos el watermark mostrado puede no ser el más viejo. Alinear código/comentario. **S**

**13. [BAJA] · corrección — `mira.ts:474`** — `?page=<id inexistente>` cae a la primera página en silencio. Loguear `mira-page-unknown`. **S**

**14. [BAJA] · robustez — `mira.ts:491-504`** — `normalizeCtx` asigna a objeto literal: `ctx.__proto__=...` muta el prototipo. `Object.create(null)`. **S**

**15. [BAJA] · dsl — `dsl/validate.ts:52` / `botler/types.ts:59`** — `channels[].schedule` existe en el tipo pero **nada lo implementa**; CSV solo como artefacto en memoria (channels publican solo HTML); PDF es decisión explícita (print-to-PDF). Rechazar `schedule` en validación mientras no exista. **S**

**16. [BAJA] · estructura — `mira.ts` (638 LOC)** — Corte por fases: `pipeline/views.ts`, `pipeline/controls.ts`, `pipeline/retrieve.ts`, `pipeline/annotations.ts`; la clase queda orquestando ~200 LOC. Todo ya es funciones puras o casi. **M**

**17. [BAJA] · estructura — `policy/clickhouse.ts`/`fabric.ts`/`frontend.ts`/`entities.ts`** — `SAFE_IDENT`+`ident()`+`settingForClaim`+`SETTINGS_PREFIX` duplicados (dos fuentes de verdad para el nombre del setting); emuladores idénticos salvo el nombre del split; `OPS`/`COMBINES`/`RELATIONS` duplicados. Extraer `codegen-common.ts`. **S/M**

**18. [BAJA] · estructura (tipos) — `mira.ts:149,284,522`, `freshness.ts:70`** — `quality` como `Record<string,unknown>` obliga al mismo cast en tres sitios; `ctx.params?.['annotations'] as AnnotationContext` sin validar. Tipar `MiraQuality` y guard mínimo. **S**

**19. [BAJA] · robustez — `botler/log.ts:48,61-70`** — `appendFileSync` síncrono por entrada bloquea el event loop en el camino de request; `verifyChain()` sobre log `retain:false` devuelve `true` vacuo. Buffer/async opcional; que `verifyChain` devuelva `{valid, verified:n}`. **S**

### Evaluación general (Opus)

Repo en forma notablemente buena: las tres rondas previas se notan (timeouts con abort real, contratos fail-loud en la frontera de datos, caché por identidad bien particionado, validaciones del DSL con errores accionables). Lo que queda es de segunda derivada: la **frontera de salida de capabilities de render es el único contrato aún casteado a ciegas** (y anula un backstop existente), el **schema JSON quedó muy por detrás del validador** (deja pasar formas que revientan con TypeError), y en policy las divergencias residuales entre backends son finas pero reales (collation de Fabric, `eq` multi-valor, idempotencia asimétrica) — todas del tipo que el differential testing actual no ve porque los generadores no las ejercitan. Prioridad: contrato de render (1), divergencias de policy (5-6), duplicados last-wins del store (8).

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8 (confirmado porque el agente hermano de admin/multipart volvió a chocar con el *safeguard de ciberseguridad de Opus*). No es contraste de motor Fable vs Opus, sino una **segunda opinión independiente en el mismo motor** — útil para ver qué hallazgos son estables entre corridas y cuáles aparecen solo en una.

He leído completos los 21 archivos del ámbito más los puntos de contacto del server (`serve-rls.ts`) y ejemplos/tests para confirmar la forma real de los specs. Informe:

---

# Revisión senior Vergis — ronda 4 (lo que queda tras R1–R3)

## Hallazgos, por severidad

### SEV alta

**1. [alta] · Corrección · `packages/mira/src/mira.ts:347-369` y `182-190` · Los casts sin validar de los renders anulan el backstop anti-página-en-blanco.**
`renderHtml` castea `(await host.capabilityCall('render-html-piece', ...)) as { html: string }` y devuelve `rendered.html` sin validar. Si la capability devuelve otra forma, `html` queda `undefined`; el backstop de la línea 204 chequea `html === ''` → `undefined !== ''` → **no dispara**, y el server hace `out.html ?? ''` (`server/serve-rls.ts:417`) → HTTP 200 en blanco: exactamente el fallo silencioso que el backstop declara prevenir. Ídem el CSV (`as { csv: string }` → artefacto con `content: undefined`). Es la asimetría con `expectRows` (mira.ts:535), que sí valida su frontera.
**Mejora:** helpers `expectString(field, capability, out)` análogos a `expectRows` para `html`/`csv` (y de paso cambiar el backstop a `!html`). **Esfuerzo S.**

**2. [alta] · Corrección/DSL · `packages/mira/src/compose.ts:216`, `mira.ts:512-514`, `dsl/validate.ts` (falta el check) · `kpi.agg.dataset` y `table.data`/`semaforo.data` sin prefijo `data.` escapan a la validación Y a la recuperación multi-vista → widget en cero/vacío en silencio.**
Evidencia: los specs reales usan nombre pelado — `examples/rls-areas.yaml:19`: `agg: { dataset: areas, ... }`. `collectDataRefs` (validate.ts:487) solo recolecta strings con prefijo `data.`, así que:
- **Validación:** un `agg.dataset` colgante (typo) pasa `validateSpec` y en compose `results[kpi.agg.dataset ?? '']?.rows ?? []` → KPI = 0 sin error. Lo mismo para `table.data: asistencia` (sin prefijo): `stripData` lo tolera en compose, pero la referencia jamás se registra → el check de dangling-reference (paso 2) no lo cubre.
- **Recuperación multi-vista:** `uniqueDatasets(active.piece)` sale de `collectDataRefs` → una página cuyo único uso de un dataset es vía `agg.dataset` (o un `data:` sin prefijo) **no lo recupera** → KPI 0 / tabla vacía renderizados como dato bueno. En un producto de reporting auditable, mostrar 0 donde había datos es el peor modo de fallo.
**Mejora:** en `validateSpec`, recolectar también `agg.dataset`/`comparison_agg`/`summary.agg` y los `data:` de table/semaforo (con o sin prefijo), validarlos contra `s.data`, y hacer que `uniqueDatasets` use ese mismo recolector. Alternativa más barata: exigir el prefijo `data.` en esos campos (como ya se exige en distribution 2·bis). **Esfuerzo M.**

**3. [alta] · Seguridad/policy · `packages/policy/src/store.ts:69,82` y `entities.ts:149,183` · Dataset duplicado en el policy store: last-wins silencioso puede abrir datos.**
`out.set(entry.dataset, policy)` sin chequear existencia. Dos entradas para el mismo dataset (p.ej. una `rls: [...]` histórica y un `grant: all` agregado después al final del YAML) → la última gana sin aviso; en el peor orden, un `grant: all` accidental anula la RLS. Nota: `entities` duplicadas SÍ se rechazan (entities.ts:130) — la asimetría con los mapeos de `datasets` delata el hueco.
**Mejora:** `throw` en dataset repetido en ambas formas (legacy y entidad-canónica). **Esfuerzo S.**

**4. [alta] · Seguridad/policy · `packages/policy/src/fabric.ts:119-137` · Comparaciones T-SQL sin COLLATE explícito: en una BD case-insensitive el enforcement concede MÁS filas que la semántica de referencia.**
`@col = read` y `@col IN (SELECT value FROM STRING_SPLIT(...))` heredan la collation de la BD. Azure SQL (que el módulo declara soportar, línea 1-2) default `SQL_Latin1_General_CP1_CI_AS` → claim `ventas` matchea filas `VENTAS`, que el evaluador de referencia (ir.ts, `===`) y ClickHouse niegan. Además el `=` ANSI ignora espacios finales (`'ventas ' = 'ventas'` → true) en cualquier collation. El emulador `emulateFabric` (fabric.ts:292: `cell === s`) NO modela la CI → el differential testing es ciego a esta divergencia precisamente donde más se necesita.
**Mejora:** emitir `COLLATE Latin1_General_100_BIN2` explícito en ambos lados de cada comparación del predicado (y documentar el tema del padding, o comparar con `DATALENGTH` si se quiere exactitud total). **Esfuerzo S.**

**5. [alta] · Seguridad · `packages/botler/src/gate.ts` (todo el módulo) · Confianza total en headers sin verificación de procedencia.**
`identityFromHeaders` acepta `x-forwarded-groups`/`x-forwarded-email` de quien sea. Todo el enforcement (RLS por claims, y la firma de tokens de anotación que usa el email — `server/serve-rls.ts:398`) descansa en que NADIE alcance el server sin pasar por oauth2-proxy: una sola desconfiguración de red (puerto expuesto, contenedor en la misma red) = claims arbitrarios = bypass total de RLS. Cero defensa en profundidad en código.
**Mejora:** al menos un secreto compartido proxy→server (header `X-Gate-Token` validado contra env) o validar el JWT firmado que oauth2-proxy puede reenviar (`X-Forwarded-Access-Token`); como mínimo, un check de arranque que se niegue a servir dato gobernado si el binding no es loopback/red interna declarada. **Esfuerzo S–M.**

### SEV media

**6. [media] · Seguridad/policy · `clickhouse.ts:91-95`, `fabric.ts:132-136` vs `ir.ts:126-129` · `op: eq` con claim multi-valor diverge de la referencia (over-grant de borde).**
Referencia: `eq` exige `allowed.length === 1 && allowed[0] === cell`. Codegen: el setting es `values.join(',')` → con claims `['a','b']` el motor compara la celda contra el literal `'a,b'` — una fila cuya celda contenga exactamente `a,b` PASA donde la referencia niega. Los emuladores siguen al motor (`cell === s`), así que reference vs emulador divergen y un property-test con comas en celdas lo detectaría — hoy es un agujero teórico pero real (las celdas sí pueden traer comas; solo los claims las rechazan).
**Mejora:** guard de cardinalidad en el codegen de `eq`: `position(',', get) = 0 AND ...` (CH) / `CHARINDEX(N',', read) = 0 AND ...` (T-SQL); o inyectar `''` para `eq` cuando el claim trae >1 valor. **Esfuerzo S.**

**7. [media] · Seguridad/ops · `fabric.ts:210-214` · `setupSQL = [DROP POLICY, DROP FUNCTION, CREATE FUNCTION, CREATE POLICY]` sin transacción → ventana sin RLS durante el re-deploy.** Entre el DROP y el CREATE la tabla queda sin FILTER PREDICATE: cualquier query concurrente ve todas las filas. **Mejora:** envolver en transacción donde el motor lo permita, o `ALTER SECURITY POLICY`/patrón create-new-then-swap. **Esfuerzo S.**

**8. [media] · Policy (divergencia entre backends) · `clickhouse.ts:106-107` · El enforcement ClickHouse NO es idempotente; el de Fabric sí.** `CREATE ROW POLICY ...` a secas falla en la segunda aplicación (ya existe), mientras Fabric hace drop-and-recreate. Divergencia operacional entre los tres backends que el task de enforcement debe conocer. **Mejora:** `CREATE ROW POLICY OR REPLACE ...` (soportado por ClickHouse). **Esfuerzo S.**

**9. [media] · Corrección/DSL · `dsl/validate.ts:163-175` · Solo se catalogan las capabilities de `data`; las de `delivery.channels[].capability` y las implícitas (`render-html-piece`, `render-csv-piece`) no.** Un channel con capability con typo pasa la validación/registro y explota en request-time con `capability-not-found` DESPUÉS de renderizar (mira.ts:216). Igual un `render: [{format: csv}]` sin `render-csv-piece` en catálogo. **Mejora:** en el paso 3, validar también channels y los renders implícitos según formatos declarados. **Esfuerzo S.**

**10. [media] · Corrección · `dsl/validate.ts:200-206` (4·ter) + `freshness.ts:110-112` · La frescura GLOBAL no valida su `watermark_field` → un typo la deshabilita en silencio.** Se valida `max_age`, pero no que el dataset del `watermark_field` exista en `data` ni que el campo esté en `shape.fields` (el check 4·ter·bis lo hace SOLO para las por-dataset). Con typo de dataset: `collectFreshnessDecls` lo declara, `checkFreshness` lo salta (`!(d.dataset in results)`) → `checked: false`, sin banner. Con typo de campo: `resolvePath` da columna de `undefined` → `toDate` null → `{checked: true, stale: false}` — «fresco» en silencio, lo contrario de lo declarado (mismo bug-class que el 4·ter·bis dice haber matado). **Mejora:** espejar 4·ter·bis para la global. **Esfuerzo S.**

**11. [media] · Corrección/DSL · `dsl/validate.ts:412-421` · El CAMPO del `source` de un control no se valida contra `shape.fields`.** Se valida el dataset, no el campo: `source: data.semanas.semanaa` (typo) → `options = []` silencioso, control vacío, `ctx` sin fijar, `:ctx.<id>` bindea `''` → páginas con 0 filas sin error. Los `interactions.filters` sí validan su campo (4·quinquies) — misma regla, aplicarla aquí. **Esfuerzo S.**

**12. [media] · Corrección · `dsl/validate.ts:240-241` + `mira.ts:178,204` · `delivery.render: []` (lista vacía explícita) esquiva validación Y backstop → página en blanco con 200.** La validación exige html solo si `renders.length > 0`; en Mira `[] ?? default` no aplica el default (no es nullish), el loop no corre y el backstop exige `renders.length > 0`. **Mejora:** rechazar el arreglo vacío en validación (`minItems: 1` en schema o check explícito). **Esfuerzo S.**

**13. [media] · Auditoría · `packages/botler/src/log.ts:40-70` · La cadena de hashes es tamper-evident solo contra corrupción accidental, no adversarial; y el truncamiento de cola es indetectable.** Sin secreto/firma/anclaje externo, quien pueda escribir el archivo puede recomputar una cadena válida; `verifyChain` tampoco detecta que se borraron las últimas N entradas (la cadena queda válida hasta donde se cortó). Además, cada reinicio del proceso escribe una cadena nueva desde GENESIS en el MISMO archivo (`server/serve-rls.ts:687`) → múltiples génesis intercalados que un verificador offline no puede distinguir de un truncamiento+reinicio forjado. No es un bug del código sino un límite del diseño que la promesa «log de auditoría hash-encadenado» sugiere más fuerte de lo que es. **Mejora:** anclar periódicamente (firmar el hash-head con clave del proceso, o exportar el último hash a un canal externo) y documentar el modelo de amenaza. **Esfuerzo M.**

**14. [media] · Policy · `store.ts:49` · Un documento con `entities`/`datasets` Y `policies` a la vez: la forma entidad gana y `policies` se ignora en silencio.** En una migración a medias, políticas legacy activas desaparecen sin aviso (deny para esas tablas — fail-closed, pero silencioso y confuso en operación). **Mejora:** `throw` si coexisten ambas formas. **Esfuerzo S.**

### SEV baja (incluye mantenibilidad)

**15. [baja] · Estructura · `mira.ts` (638 LOC, `invoke` ~150) · Corte por fases propuesto.** El pipeline ya está numerado en comentarios (2·bis … 6·bis); materializar ese corte: `view.ts` (resolveActiveView, contextPrompt, normalizeCtx — ya casi puro), `controls.ts` (resolveHeaderControls + resolveControlValue/s + stripCtrlSource), `retrieve.ts` (applyCtx, expectRows, watermarkDatasetOf, loop de retrieval), `annotations.ts` (applyAnnotations, findTargetTable), dejando `mira.ts` como orquestador de ~200 LOC. Los helpers ya son funciones puras exportadas — es mover, no refactorizar. **Esfuerzo M.**

**16. [baja] · Estructura/policy · Duplicación triple entre backends.** `SETTINGS_PREFIX`, `SAFE_IDENT`, `ident()`, `settingForClaim()` duplicados en `clickhouse.ts` y `fabric.ts`; la lógica de visibilidad por cierre (ancestros→descendientes) vive TRES veces (ir.ts:104, clickhouse.ts:190, fabric.ts:284); `emulate`/`emulateFabric` son isomorfos salvo el split; `frontend.ts` y `entities.ts` duplican `OPS`/`COMBINES`/`RELATIONS` y el parseo de gobierno. Extraer `codegen-common.ts` + parametrizar el emulador. Riesgo real: un fix de semántica aplicado a una copia y no a las otras (el patrón del hallazgo 4/6). **Esfuerzo M.**

**17. [baja] · DSL · `dsl/validate.ts:52` · `channels[].schedule` declarado en el tipo pero jamás leído (grep: cero consumidores; el trigger `'scheduled'` de types.ts tampoco tiene scheduler).** `delivery.render[].target` ídem. Conviene rechazarlas en validación con error «no implementado» (coherente con la filosofía fail-loud del resto: hoy un spec con `schedule: "0 7 * * 1"` promete algo que nunca ocurrirá, en silencio). **Esfuerzo S.**

**18. [baja] · DSL · Divergencias schema JSON ↔ validador.** El schema deja `quality`, `delivery`, `shape` e `interactions` como objetos libres mientras el validador implementa su semántica (deriva natural: cada regla nueva vive solo en TS). Puntual: `controls[].source` en el schema exige `^data\.x\.y$` pero `stripCtrlSource` (mira.ts:582) tolera la forma pelada — tolerancia muerta que confunde; `shape.type` sin whitelist → `single-row` (typo) desactiva el check de shape en silencio (mira.ts:375); `mira_version` sin gate semántico de mayor soportada. Alinear (o generar el schema desde los tipos). **Esfuerzo S–M.**

**19. [baja] · Robustez · `dsl/validate.ts` recursiones sin límite de profundidad.** El guard de 32 niveles vive solo en `composePiece`; `validatePieceNode`/`collectDataRefs`/`collectDrills`/`collectDistributions` recursan sin cota y corren ANTES — un spec patológicamente profundo (o circular vía anchors YAML, que el paquete `yaml` construye) revienta con `RangeError` crudo en vez del VergisError accionable. Autores de spec son confiables → baja. **Esfuerzo S.**

**20. [baja] · Cache · `result-cache.ts` · Dos notas.** (a) La clave no incluye versión de policy: si el admin cambia la policy de un dataset, los consumidores siguen viendo el resultado viejo hasta vencer el TTL (acotado por diseño, pero conviene documentarlo o invalidar el caché en hot-reload de policies). (b) `getLastValid` no tiene ningún consumidor — `show_last_valid` en mira.ts:313-323 admite explícitamente que no lo usa. Feature muerta: cablearla o quitarla. **Esfuerzo S.**

**21. [baja] · Auditoría · `botler.ts:137` · `policy-check ... decision: 'allow'` es un passthrough que registra una «decisión» que nadie evaluó.** Un auditor leyendo el log concluiría que hubo un check de política. Renombrar el evento (`policy-check-passthrough`) hasta que exista el PDP real. **Esfuerzo S.**

**22. [baja] · Corrección menor · `mira.ts:162-171` · El tope interactivo suma TODOS los `results`** (incluidos el dataset del watermark y los de controles) y materializa datasets no referenciados por ningún filtro → puede saltarse las facetas por culpa de datasets irrelevantes, y cuando materializa, embebe de más (HTML más pesado; no es fuga: todo pasó por RLS). Filtrar a los datasets que los `filters` referencian. **Esfuerzo S.**

**23. [baja] · Perf · `log.ts:48` `appendFileSync` por entrada en el camino del request** (cuando hay `logPath`); hoy el server per-request no pasa `logPath`, así que es latente. Y `cli/main.ts:6-9` `arg()` puede tomar el flag siguiente como valor (`--log --out` → log llamado `--out`). **Esfuerzo S.**

## ¿Qué verifiqué que está bien resuelto? (no repetir en próximas rondas)

- **Timeout de `capabilityCall`** (botler.ts:138-169): presente, default 120 s, con `AbortSignal` abortado al vencer, `timer.unref()`, `clearTimeout` en finally; el `Promise.race` no deja rejections huérfanas (race se suscribe a ambas).
- **`expectRows`**: presente y usado en LOS DOS caminos de retrieval (páginas mira.ts:130 y fuentes de controles :249). El contrato de frontera de datos está cerrado; el hueco restante es el de renders (hallazgo 1).
- **Límite de profundidad en compose**: `MAX_PIECE_DEPTH = 32` con VergisError accionable (compose.ts:170-186).
- **`result-cache`: SIN colisiones entre identidades RLS.** La clave incluye capability + params canónicos + user + agent + claims normalizados (arreglo ordenado, `{g:'a'}` ≡ `{g:['a']}`); serialización JSON canónica → sin ambigüedad de separadores. Dos identidades con claims distintos jamás comparten entrada. El anti-aliasing de filas cacheadas en anotaciones (mira.ts:431-435) y la copia de `columnsSpec` (compose.ts:309-312) protegen el valor cacheado y el spec memoizado de mutación.
- **Fail-closed del enforcement en ambos codegens**: guard `!= ''`/`<> ''` en cada predicado, claim ausente → deny; valores de claim SIEMPRE parametrizados (settings CH / `sp_set_session_context` con parámetro), identificadores validados por `SAFE_IDENT`, comas rechazadas; la reinyección TOTAL del SESSION_CONTEXT por request (fabric.ts prelude) mata la fuga por pool. `applyCtx` bindea, nunca interpola; los valores multi-select se filtran contra el catálogo de opciones.
- **`verifyChain`**: la recomputación (hash + prevHash por entrada desde GENESIS) es correcta para lo que promete en memoria; el límite es de diseño (hallazgo 13), no de implementación.
- **Backstops del DSL ya en su sitio**: XOR piece/pages, drills validados (destino + contexto), filtros client-side validados (dataset + campo), ejes de distribution calificados, whitelist de tipos de elemento, `max_age` parseable, watermark per-dataset validado, hardening del catálogo de serving (`registerStarters: false` en el server).

## Evaluación general

El repo está en forma notablemente buena tras tres rondas: la filosofía fail-loud/fail-closed está internalizada y ejecutada con consistencia (los comentarios que documentan *por qué* cada guard existe son de calidad senior), la separación Botler-genérico / Mira-configuración / policy-compilada es limpia, y los mecanismos críticos (RLS parametrizada, caché por identidad, timeout con abort, anti-fuga de pool) están correctos donde importa. Lo que queda cae en tres patrones: **(1) fronteras asimétricas** — se blindó la entrada de datos (`expectRows`) pero no la salida de renders, se blindó la frescura per-dataset pero no la global, se validan filtros pero no controles/aggs: el criterio existe, falta aplicarlo uniformemente; **(2) divergencias entre los tres backends de policy** que el differential testing no ve porque los emuladores replican al motor idealizado, no al motor real (collation, eq multi-valor, idempotencia) — es el punto más delicado porque el marco de pruebas da falsa confianza justo ahí; y **(3) promesas del modelo mayores que la implementación** (headers de gate sin defensa en profundidad, cadena de hashes sin anclaje, `schedule` declarado sin scheduler) — ninguna es un bug, pero las tres merecen o cerrarse o declararse explícitamente como supuestos de despliegue. Nada de lo hallado exige rediseño; los cinco altas se resuelven en días, no semanas.

---

• *Generado con [Wingworking](https://wingworking.org)*
