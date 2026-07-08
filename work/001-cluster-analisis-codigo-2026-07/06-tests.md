# Frente 06 · Calidad de tests

**Ámbito:** suite hermética en `tests/` (~55 archivos), cobertura real, huecos en superficies de seguridad, determinismo.

---

## Tanda Opus 4.8 — concluida

### Resultado de la ejecución
`npm test` (vitest 2.1.8, Node 22.22.3): **52 archivos / 393 tests, 100% verde**, 0 skips, exit 0. Duración **6.5s** wall. **1.057 `expect()` estáticos**; los property tests diferenciales de `policy.test.ts` corren 800 iteraciones cada uno (~2.400 comparaciones). Solo dos `stderr` intencionales (log del fallback agéntico). Sin provider de coverage instalado.

### Módulos de producción sin cobertura

| Módulo | LOC | Estado |
|---|---|---|
| **`server/serve-rls.ts`** | **916** | **CERO tests.** El servidor HTTP real: routing, `canAccess`/`visibleFor`, `identityFor`, `handleAnnotationWrite`+HMAC, `readJsonBody` (64KB), `ADMIN_SEED`, `reloadGovernance`, SIGHUP/watch. Inimportable por efectos de módulo (`createServer` top-level). |
| `execute-sql-dwh.ts` | 150 | Sin tests (su gemelo `execute-sql-ch.ts` SÍ se testea con transporte fake). |
| `clickhouse-store.ts` | 135 | Sin tests — cliente CH real (red); exclusión defendible. |
| `markdown.ts` | ~60 | Sin tests directos (la barrera XSS); solo transitivamente vía render. |
| `publicar-artefacto.ts` | ~50 | Sin referencia directa; a lo sumo vía `runSpec`. |

Todo lo demás (policy, mira/DSL, botler, table-runtime, freshness×4, governance, admin, intake, master-data, multipart, hot-reload, nav, catalog, pi-config, sql-tables, ui) tiene tests dedicados.

### Hallazgos

**1. [ALTA]** · `serve-rls.ts` (916 LOC) es la superficie de seguridad más grande y la única sin ningún test (authz por identidad, composición ACL-de-PI + RLS, enriquecimiento de claims). Un bug ahí no lo detecta nada. · Extraer factoría `createRlsServer(deps)` (patrón ya usado con `nav.ts`, `createAdmin`) y testear rutas con los mocks req/res existentes. · **L**

**2. [ALTA]** · El gate de escritura de anotaciones no tiene test adversarial: `annSign` (HMAC) y su verificación en `handleAnnotationWrite` nunca se prueban. Los tests usan tokens fake. Nadie verifica que un token forjado, de otra identidad o de otra fila se rechace. · Test del handler: token válido acepta; de otra identidad/clave/PI rechaza; JSON >64KB rechaza. · **S–M** (tras el punto 1)

**3. [ALTA]** · Hueco real de producto sin test: `reloadGovernance` hace swap del policy store pero **no invalida el result-cache** (`serve-rls.ts:309` vs `:893-905`). Si se endurece una policy en caliente, la misma identidad sigue recibiendo filas pre-cambio hasta vencer el TTL (mitigado porque el default es TTL=0). · Invalidar el caché en el reload + test "policy endurecida → siguiente request NO sirve el hit viejo". · **S**

**4. [MEDIA]** · `multipart.test.ts` cubre un solo malformado. Faltan: parte truncada, headers sin línea en blanco, boundary final ausente, boundary dentro del contenido, límites de tamaño. · **S**

**5. [MEDIA]** · `verifyChain()` solo se asertea `true`. No existe el test negativo — archivo adulterado (línea modificada/eliminada/reordenada) → `false`. Es la propiedad que justifica la cadena. · **S**

**6. [MEDIA]** · Hot-reload bajo concurrencia: `debounce`/`createCachedScanner`/`watchPaths` bien testeados en aislamiento, pero no hay test de rebuild con requests en vuelo ni del camino SIGHUP (vive en el módulo intesteable del punto 1). · **M**

**7. [MEDIA]** · `execute-sql-dwh.ts` no tiene el arnés de transporte fake que sí tiene ClickHouse; la reinyección del prelude `SESSION_CONTEXT` por request y el abort del punto mssql quedan sin prueba de integración. · **M**

**8. [BAJA]** · Duplicación: `mockReq`/`mockRes` copy-paste en 5 archivos; `mkdtempSync` en 17. No hay `tests/helpers/`. Extraer `tests/helpers/http.ts` y `withTmpDir()`. · **S**

**9. [BAJA]** · Determinismo casi impecable (PRNG LCG con seed, `clock` inyectable, fake timers). Dos excepciones: `freshness-multipage.test.ts:72` usa `new Date()` (flake en borde de medianoche UTC); el test de `watchPaths` duerme 200ms reales. · **S**

**10. [BAJA]** · `markdown.ts` (`escapeHtml`) sin tests directos siendo barrera XSS; solo un test del payload JSON de tabla. · **S**

**Nota de alcance:** del "sin cubrir" de junio, **CSV ya está implementado y testeado** (`render-csv.test.ts`), **PDF es no-feature deliberada** (print-to-PDF, documentado en `mira.ts:175`), y el scheduling que existe (`FabricScheduler`) se ejercita vía `frescura-frente-b`. El CSV se genera como artifact pero no hay ruta HTTP de descarga en `server/` — hueco de producto, no de tests.

### Evaluación de salud (Opus)

Suite en muy buena forma: rápida (6.5s), 100% hermética y verde, cero snapshots frágiles (los únicos asserts byte-exactos son DDL de policy, contrato deliberado), alta densidad de casos negativos (CSRF, 403/404 sin filtrar existencia, inyección SQL, default-deny, fail-loud del DSL), y dos joyas: el arnés diferencial policy (codegen CH ≡ Fabric ≡ oráculo, 1.600 iteraciones con seed) y el aislamiento por identidad del result-cache probado explícitamente. El talón de Aquiles es serio y único: toda esa calidad protege las **librerías**, pero el **binario que corre en producción** (`serve-rls.ts`) quedó fuera del alcance por sus efectos de módulo, y ahí hay un hueco real (result-cache no invalidado en hot-reload). La inversión que más paga es la refactorización testeable de ese archivo (hallazgos 1–3).

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8. No es contraste de motor, sino una segunda opinión independiente. Fue el único de los siete que emitió notificación de término limpia.

**Ejecución:** `npm test` (Node 22.22.3) — **52 archivos / 393 tests / 1.057 asserts, todo verde**, 5.56 s wall (collect 28.1 s en workers, 619% CPU). 2 stderr esperados (logs del fallback agéntico). Coincide con la primera corrida.

**Módulos sin cobertura (confirmados leyendo imports):**

| Módulo | LOC | Qué queda sin probar |
|---|---|---|
| `server/serve-rls.ts` | 916 | El binario de producción. **Confirmado inimportable**: `createServer` (L531), `listen` (L877), parsing de ~20 env vars, `fs.watch`, `SIGHUP` — todo a nivel de módulo. `serve-rls.test.ts` existe pero **no lo importa** (ejercita `runSpec`+`emulate`, otra capa). Sin probar: routing y su orden, `handleAnnotationWrite`/`annSign` (HMAC), wiring identidad→RLS, `reloadGovernance`, `healthz`, fail-closed de Fabric. |
| `execute-sql-dwh.ts` | 150 | Conector Fabric enforcing: re-inyección de `sp_set_session_context` por query (defensa anti-fuga entre consumidores con pool) y parametrización `@vergis_sc_N`. Cero tests. |
| `clickhouse-store.ts` | 135 | `bootstrapClickHouse` (aplica DDL + `CREATE ROW POLICY`) y `createIngestClickHouse`. El codegen sí está testeado; la **aplicación** no. |

**Hallazgos:**

- **[ALTA]** `serve-rls.ts` inimportable y sin tests. Extraer `createApp(config): RequestListener` + `configFromEnv()`, dejando solo el `listen`; testear rutas por inyección (patrón ya en `createAdmin`/`tryHandle`). **L** (habilita varios S).
- **[ALTA]** Gate de escritura de anotaciones sin test negativo: `handleAnnotationWrite`+`annSign` (HMAC por slug+email+key) sin test de token forjado, de **otra** identidad (email distinto → 403), ni key no visible. Único surface mutable para consumidores. **S** (tras el refactor; **M** sin él).
- **[ALTA]** `verifyChain` nunca probado en negativo: los usos asertan `true`; jamás se verifica que un log **adulterado** (mutar campo/hash o reordenar) dé `false`. Una cadena cuyo detector de tampering no se probó no acredita nada. **S**.
- **[ALTA]** `execute-sql-dwh.ts` sin tests (motor Fabric enforcing): la re-inyección de `SESSION_CONTEXT` por request neutraliza la fuga entre consumidores por pool; si una regresión la rompe, nada lo nota. Test con transport fake: cada `execute` antepone TODAS las settings (incl. claim ausente con `''`) y A no contamina a B. **M**.
- **[MEDIA]** Hot-reload de policy endurecida no invalida el result-cache, sin test de la interacción: `reloadGovernance` hace swap pero `servingCap` (envuelto con `withResultCache`) conserva entradas → misma identidad+SQL sigue viendo filas viejas hasta vencer TTL. **M**.
- **[MEDIA]** `bootstrapClickHouse` sin test hermético (puente codegen→motor). Test con `ChAdminConn` fake que capture y asserte los statements. **S/M**.
- **[MEDIA]** Multipart: solo 1 malformado. Faltan parte truncada, sin boundary de cierre, `Content-Disposition` sin `name`, headers gigantes, boundary dentro del contenido. **S**.
- **[BAJA]** Duplicación de helpers: `mockReq`/`mockRes` ×5, `mkdtempSync` ×17; sin `tests/helpers/`. **S**.
- **[BAJA]** Un sleep real (`hot-reload.test.ts:84`, 200 ms) + delays en `retrieval-parallel`: único punto de flakiness en CI cargado. Polling con deadline. **S**.
- **[BAJA]** Relojes no inyectables en `mira.ts` (`Date.now()` L138, `new Date()` L356) y stores; hoy no causa flakes pero impide contract-tests de frescura por `runSpec` en los bordes. **S/M**.

**Evaluación (segunda corrida):** coincide con la primera en el diagnóstico central — suite excelente (rápida, hermética, sin snapshots frágiles, property test seeded, no-fuga entre identidades probada), pero **toda la calidad se detiene en el borde del binario de producción**: `serve-rls.ts` es estructuralmente intesteable y los dos conectores que materializan la RLS contra motores reales (`execute-sql-dwh`, `clickhouse-store`) tienen cero tests; y el detector de adulteración de auditoría (`verifyChain`) nunca se probó detectando una adulteración. La inversión correcta es una sola: el refactor `createApp()`/`configFromEnv()`, que convierte tres hallazgos ALTA en tests de una tarde.

---

• *Generado con [Wingworking](https://wingworking.org)*
