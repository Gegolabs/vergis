# Diseño #108 — Convención del corte as-of en el header de los PI

**Issue:** [Gegolabs/vergis#108](https://github.com/Gegolabs/vergis/issues/108) · feat(render)
**Rol:** documento de diseño ejecutable (ww:wingcoding). Lo implementa un agente Opus en frío: todo lo que necesita está aquí o referenciado por ruta exacta.
**Rama de trabajo:** una rama nueva desde `main` (p. ej. `feat/as-of-header`), en worktree propio.
**Gates:** `npm run typecheck` && `npm test` && `npm run build` — los tres verdes antes de dar por cerrado.

---

## ¿Cuál es el problema?

Un PI muestra cifras a una fecha de corte, pero esa fecha no tiene lugar convenido en la superficie. El pedido del issue: **convención de plataforma** para el corte as-of en el header — misma posición, mismo formato, en todos los PIs por igual, **no configurable per-PI**.

Evidencia medida (comentario del issue, instancia GH): el header hoy estampa `Generado 04 ago 2026, 08:29 a. m.` — la hora del **render**, no el corte del dato. Enmascara frescura (dato quieto hace días luce «generado hace 1 minuto») y rompe la comparación byte-a-byte de renders del mismo dato (dos tomas a 90 s difieren exactamente en los dígitos del minuto, y en nada más).

## ¿Qué hay hoy? (estado verificado contra el código)

Todo lo siguiente está verificado leyendo el código en `main` (2026-08-06); las rutas y líneas son los puntos reales de inserción.

1. **El header se compone en el theme.** `packages/capabilities/src/themes/arbol.ts`, método `wrap()` (líneas 98–107 arman `metaBlock`; línea 270 lo inserta en `<header class="app-header">`). El bloque `.meta` (derecha del header) tiene dos líneas condicionales:
   - `.date` → `Datos al {formatDate(meta.date)}` — **solo si llega `meta.date`**.
   - `.gen` → `Generado {formatDateTime(meta.generatedAt)}` — el sello de render que el issue objeta.
   El theme `default` (`packages/capabilities/src/themes/default.ts`) **no pinta bloque meta alguno** en el header (solo `controls`): la convención hoy ni siquiera es pareja entre themes.
2. **`meta` lo arma Mira, no el server.** `packages/mira/src/mira.ts`, método privado `renderHtml` (líneas 409–453): `meta: { date: freshness.watermark, generatedAt: new Date(), org, classification, code, version }`. El shape es `DashboardMeta` (`packages/capabilities/src/themes/index.ts`, líneas 19–33).
3. **`freshness.watermark` es opt-in del spec.** Sale de `checkFreshness` (`packages/mira/src/freshness.ts`): solo existe si el spec declara `quality.freshness.watermark_field` (global) o `data.<ds>.freshness` (por-dataset) y la ruta resuelve. Sin declaración → `{ checked: false }` → sin watermark → **hoy no hay «Datos al» en el header**. Ese es exactamente el hueco del issue: el as-of depende de que cada spec coopere.
4. **El server NO pasa hoy ningún dato de frescura al render.** Cadena de servido: `server/serve-rls.ts` `runPi()` (línea 419) → `runSpec()` (`packages/cli/src/run.ts`, línea 120) → `botler.invoke(..., { params })` (líneas 156–166) → `MiraBotlet.invoke` lee `ctx.params` (`packages/mira/src/mira.ts`, p. ej. `notas` en línea 154, `baseDir` en línea 220). `RunOptions` no tiene campo de frescura; `meta` se arma solo dentro de Mira. **El cableado server→render hay que construirlo** (es el objeto de este diseño).
5. **La última ingesta exitosa la sabe la plataforma, pero solo la consulta el área admin.** `classifyProcess(...).lastSuccessAt` (`packages/capabilities/src/ingestion-observability.ts`, líneas 37–46) sobre el run-history que entrega `fabricWiring.engine.listRunHistory(processId)` (`server/serve-rls.ts` línea 816, cliente en `packages/capabilities/src/fabric-engine.ts` líneas 123–147 — llamada REST viva a Fabric). Hoy solo la usan la vista admin `domainFreshness` (serve-rls.ts líneas 1022–1055) y el monitor de alertas (líneas 955–983, que persiste solo `alertState`, no fechas). **No existe caché de `lastSuccessAt` reutilizable por el serving.**
6. **Los dominios de un PI no se declaran: se derivan.** El spec no tiene campo de dominio. La cadena real (la misma de `freshnessInputs`, serve-rls.ts líneas 920–934, y `domainFreshness`): `Report.tables` (derivadas del SQL de `data.*` en `server/discovery.ts`, líneas 85–86, `analyzeSqlTables`) → `govStore.listProcessOutputs()` (tabla→proceso) → `listProcesses()` (proceso→`sourceId`, `engine`) → `listSources()` (fuente→`domain`). Labels legibles de dominio: `domainsCfg` (`parseDomainsConfig` sobre `VERGIS_DOMAINS`, serve-rls.ts líneas 387–390).
7. **Casos sin run-history** (importan para el fail-visible): despliegue sin conexiones Fabric o sin `VERGIS_INTAKE_SP` → `fabricWiring = {}` → sin `engine` (serve-rls.ts líneas 804–812; el modo clickhouse cae aquí); proceso sin `engine` ref → `listRunHistory` devuelve `[]` (fabric-engine.ts línea 133); error de API → hay que capturarlo; tabla sin proceso productor registrado.
8. **Nadie más asserta el sello.** `grep` de `Generado` en `tests/` no da resultados; `Datos al` solo aparece en `tests/stale-degradation.test.ts` (líneas 47 y 61) y es el **banner** de staleness (`staleBanner`, mira.ts líneas 355–407), que este diseño no toca.

---

## Decisiones selladas

### D1 — Qué fecha se muestra: precedencia de plataforma, watermark → ingesta → no-disponible

El corte as-of del header se resuelve con esta precedencia, fija para todos los PIs:

1. **Watermark del dato** (`freshness.watermark`), si el spec la declara y resuelve. Racional: es el as-of más fiel — la fecha del **contenido** del dato (p. ej. la columna snapshot), estrictamente mejor que la hora en que corrió la ingesta. Además mantiene consistencia interna: el banner de staleness ya dice «Datos al {watermark}» (mira.ts línea 405); header y banner deben nombrar la misma fecha.
2. **Última ingesta exitosa, la más antigua de los procesos productores de las tablas del PI** (fallback de plataforma, universal — no requiere cooperación del spec). Racional del mínimo: cada tabla está al día de SU ingesta; el conjunto solo puede **garantizar** el mínimo — cifras posteriores al proceso más atrasado pueden faltar. Es el «corte garantizado»: *todo lo que se ve está completo hasta esta fecha*.
3. **Ninguna de las dos** → estado no-disponible (D5).

Esto **no** es configurabilidad per-PI: ningún knob del spec elige posición, formato ni presencia de la línea; la precedencia es regla de plataforma (un spec que declara watermark declara calidad de datos, no apariencia). La línea aparece **siempre**, en todo PI, en todo theme.

### D2 — Posición y formato: primera línea del bloque meta del header, es-CL, grano según el dato

- **Posición:** el bloque `.meta` a la derecha del header (donde hoy vive en `arbol`), primera línea, estilo destacado (la clase `.date` existente en arbol: `font-weight: 600`). El theme `default` **incorpora el mismo bloque** — la convención es de plataforma, no del theme.
- **Prefijo y formato:** `Datos al {fecha}`, es-CL, con los formatters que ya existen en `arbol.ts`:
  - corte de **grano fecha** (string `YYYY-MM-DD`) → `formatDate` («4 de agosto de 2026», TZ UTC);
  - corte con **hora** (ISO con componente horaria) → `formatDateTime` («04 ago 2026, 08:29», TZ America/Santiago).
  El grano lo determina el **dato** (la forma del string del corte), jamás el spec — regla uniforme, un solo formato por grano.
- **Markup compartido:** un módulo nuevo `packages/capabilities/src/themes/as-of.ts` exporta `asOfBlock(asOf): string` (el HTML del bloque, con `escapeHtml`) y los formatters movidos/compartidos; `arbol.ts` y `default.ts` lo llaman. Así los dos themes emiten byte-idéntico el mismo bloque y el test lo verifica una sola vez por theme.

### D3 — «Generado» se elimina del HTML

`generatedAt` sale de `DashboardMeta`, de la composición en `mira.ts` y del theme. Racional (los dos argumentos del issue): (a) enmascara frescura respondiendo «¿cuándo se dibujó?» cuando el lector pregunta «¿a qué momento corresponde?»; (b) con él fuera, **dos renders del mismo dato son byte-idénticos** — propiedad que las suites del Producto pueden explotar (la evidencia del issue midió que el minuto del sello era la única diferencia; el test T4 lo re-verifica como experimento propio). El «cuándo se sirvió» no queda en la página; si algún día hace falta, es un header HTTP, no contenido del documento.

### D4 — Multi-dominio: corte = mínimo, detalle por dominio en tooltip

Cuando el corte viene de ingesta y el PI toca varios dominios: el corte mostrado es el **mínimo** (D1.2) y el detalle vive en el atributo `title` del div `.date` (tooltip nativo, sin JS), una línea por dominio:

```
Corte garantizado: la ingesta más antigua de los dominios del PI.
Personas: 04 ago 2026, 07:00
Cartera / Finanzas: 03 ago 2026, 22:15
```

- Label del dominio: desde `domainsCfg` (id→label); dominio sin declarar en config → su id; fuente sin `domain` → agrupada como `(sin dominio)`. Por dominio se muestra el mínimo de sus procesos involucrados.
- Si el corte viene de watermark (D1.1), el tooltip dice `Corte declarado por el dato del PI (marca de agua).` — y nada más (el detalle de ingesta no aplica al corte mostrado).
- Con un solo dominio el tooltip se emite igual (una línea de detalle): uniformidad sobre casuística.

### D5 — Fail-visible: «corte no disponible», nunca silencio ni fecha inventada

Sin watermark y sin ingesta conocida (engine ausente — modo clickhouse, CLI suelto, preview de Miranda —, proceso sin `engine` ref, error/timeout de la API, tablas sin proceso productor): la línea se pinta igual, en el mismo lugar, con el texto **`Datos: corte no disponible`** (estilo dim, la clase `.gen` existente sirve de referencia visual) y `title` explicando: `La plataforma no tiene registro del corte de estos datos.`. La línea **nunca** se omite y **jamás** se rellena con la hora del render.

### D6 — Cableado server → render (los puntos exactos)

El dato viaja por la cadena de params que ya existe (`runPi → runSpec → botler.invoke → ctx.params`), como viaja `notas`:

1. **Derivación pura** (testeable sin server) en `packages/capabilities/src/ingestion-observability.ts`:
   ```ts
   export interface AsOfDetail { domainId: string | null; label: string; lastSuccessAt: string }
   export interface PiAsOf { cutoff: string | null; detail: AsOfDetail[] }
   export function deriveAsOfIngesta(input: {
     tables: string[]
     processOutputs: { processId: string; tableRef: string }[]
     processes: { id: string; sourceId: string }[]
     sources: { id: string; domain?: string }[]
     domainLabels: Record<string, string>
     lastSuccessByProcess: Record<string, string | null>  // ISO o null (sin corrida exitosa)
   }): PiAsOf
   ```
   Semántica: procesos involucrados = los que producen alguna tabla del PI; si **alguno** de ellos no tiene `lastSuccessAt` conocido → `cutoff: null` (no se puede garantizar un corte con un insumo de fecha desconocida — el mínimo sería una mentira), con el `detail` de los que sí se conocen; si todos se conocen → `cutoff` = mínimo. Sin procesos involucrados → `{ cutoff: null, detail: [] }`. Export en `packages/capabilities/src/index.ts` (junto a `classifyProcess`, línea 127).
2. **Proveedor con caché TTL** también en `ingestion-observability.ts` (seams inyectados → testeable):
   ```ts
   export function createAsOfProvider(deps: {
     engine: IngestionEngineClient | undefined
     loadTopology: () => Promise<{ processOutputs: ...; processes: ...; sources: ...; domainLabels: ... }>
     now?: () => number
     ttlMs?: number        // default 60_000
     timeoutMs?: number    // default 3_000
   }): (tables: string[]) => Promise<PiAsOf>
   ```
   Comportamiento: cachea por `processId` el `lastSuccessAt` (de `classifyProcess(runs, Infinity, now).lastSuccessAt` — la cadencia no importa aquí, solo la última exitosa) durante `ttlMs`; misses en paralelo (`Promise.all`); cada `listRunHistory` envuelto en catch + timeout de `timeoutMs` → a fallo/timeout ese proceso queda `null` (→ D5 vía la regla de la derivación) y se cachea el `null` por el mismo TTL (no martillar una API caída). Sin `engine` → siempre `{ cutoff: null, detail: [] }` sin llamar nada.
3. **Server** (`server/serve-rls.ts`): instanciar el provider junto a `freshnessInputs` (zona líneas 918–934) con `engine: fabricWiring.engine`, `loadTopology` sobre `govStore.listProcessOutputs()/listProcesses()/listSources()` + `domainsCfg`; en `runPi()` (línea 419): `const asOf = await asOfFor(report.tables)` y pasarlo en el objeto de `runSpec({ ..., asOf })`. Nota: `fabricWiring` se arma dentro del bloque de administración (try de la línea ~800); si la administración está deshabilitada el provider se crea sin engine (fail-visible D5), no se omite.
4. **CLI** (`packages/cli/src/run.ts`): `RunOptions.asOf?: PiAsOf` (importa el tipo de `@vergis/capabilities`, ya dependencia) y forward en `botler.invoke` params (líneas 156–166, junto a `notas`).
5. **Mira** (`packages/mira/src/mira.ts`): en `invoke`, leer `const asOfParam = ctx.params?.['asOf']`; en `renderHtml` (líneas 409–453) resolver la precedencia D1 y componer el nuevo shape del meta:
   ```ts
   meta: {
     asOf: freshness.watermarkRaw != null
       ? { cutoff: freshness.watermarkRaw, source: 'watermark' }
       : asOfParam?.cutoff != null
         ? { cutoff: asOfParam.cutoff, source: 'ingesta', detail: asOfParam.detail }
         : { cutoff: null, source: 'none' },
     org, classification, code, version,   // sin date ni generatedAt
   }
   ```
   `watermarkRaw` es un campo nuevo de `FreshnessVerdict` (`packages/mira/src/freshness.ts`): el **string original** del watermark (`YYYY-MM-DD` o ISO completo), que `checkOne` ya tiene en `watermarkValue` (línea 110) — es lo que preserva el grano para D2 (un `Date` no distingue «solo fecha» de «medianoche real»). Se agrega en los dos returns de `checkOne` (líneas 123–131 y 136–144) y se propaga en el agregado de `checkFreshness` (líneas 55–64).
6. **Themes** (`packages/capabilities/src/themes/`): en `index.ts`, `DashboardMeta` reemplaza `date`/`generatedAt` por `asOf?: { cutoff: string | null; source: 'watermark' | 'ingesta' | 'none'; detail?: AsOfDetail[] }`; nuevo `as-of.ts` con `asOfBlock()`; `arbol.ts` reemplaza su `metaBlock` (líneas 99–107) por el bloque compartido; `default.ts` agrega el bloque a su header (línea del `wrap`, hoy solo `controls`) más el CSS mínimo (`.meta`, `.date`, `.gen`-equivalente). Es cambio de contrato interno **pre-launch**: se corrige en todos los lados a la vez (criterio de excelencia), sin capa de compatibilidad con el shape viejo.

### D7 — Qué NO entra

- El **banner** de staleness (mira.ts `staleBanner`) no se toca: es calidad/degradación, otro contrato.
- El **CSV** (`render-csv-piece`) no lleva meta: fuera.
- No se agrega columna/vista nueva en admin, no se toca el monitor de alertas ni el reconciliador.
- Nada de chips ni cuerpo del PI (franja de #114).

---

## ¿Qué territorio toca cada tarea?

| Archivo | Tarea |
|---|---|
| `packages/capabilities/src/ingestion-observability.ts` | T1 (deriveAsOfIngesta, createAsOfProvider, tipos) |
| `packages/capabilities/src/index.ts` | T1 (exports) |
| `packages/mira/src/freshness.ts` | T2 (`watermarkRaw`) |
| `packages/mira/src/mira.ts` | T2 (param `asOf`, meta nuevo) |
| `packages/cli/src/run.ts` | T2 (RunOptions.asOf + forward) |
| `packages/capabilities/src/themes/as-of.ts` (nuevo) | T3 |
| `packages/capabilities/src/themes/index.ts` | T3 (DashboardMeta) |
| `packages/capabilities/src/themes/arbol.ts` | T3 (header) |
| `packages/capabilities/src/themes/default.ts` | T3 (header + CSS del bloque) |
| `server/serve-rls.ts` | T4 (provider + inyección en `runPi`) |
| `tests/as-of-derive.test.ts` (nuevo) | T1 |
| `tests/header-as-of.test.ts` (nuevo) | T3/T5 |

Fuera de este listado, ningún archivo se edita.

## Tareas y «hecho cuando»

**T1 — Derivación pura + proveedor cacheado** (`ingestion-observability.ts`).
Hecho cuando `npx vitest run tests/as-of-derive.test.ts` pasa, con al menos: (a) tres dominios, cortes distintos → `cutoff` = el mínimo y `detail` con label por dominio; (b) un proceso involucrado sin corrida exitosa → `cutoff: null` con detail parcial; (c) tablas sin proceso productor → `{null, []}`; (d) provider: 2ª llamada dentro del TTL no re-invoca `listRunHistory` (engine fake con contador), pasada el TTL sí; (e) engine que lanza o se cuelga (timeout fake con `now` inyectado o promesa colgada) → `cutoff: null`, sin excepción propagada; (f) sin engine → `{null, []}` y cero llamadas.

**T2 — Watermark con grano + param en Mira + forward del CLI.**
Hecho cuando el typecheck pasa y los tests de T5 (precedencia) pasan. Verificación negativa incluida: `grep -rn "generatedAt" packages/ server/` no devuelve ocurrencias (el campo se extinguió del contrato).

**T3 — Bloque as-of compartido en ambos themes.**
Hecho cuando en `tests/header-as-of.test.ts` pasan, **para arbol y para default** (llamando `theme.wrap` directo con meta fake): (a) `asOf` con cutoff `2026-08-04` (grano fecha) → el HTML contiene `Datos al 4 de agosto de 2026` dentro del header; (b) cutoff ISO con hora → formato `formatDateTime` (contiene la hora); (c) `source: 'ingesta'` con `detail` de dos dominios → el `title` del `.date` contiene ambos labels y `Corte garantizado`; (d) `source: 'none'` → contiene `corte no disponible`; (e) el HTML no contiene `Generado` en ningún caso.

**T4 — Cableado del server.**
Hecho cuando los gates completos pasan (`npm run typecheck && npm test && npm run build`) — el server no tiene arnés propio de request; su lógica riesgosa (derivación, caché, timeout) quedó íntegramente en T1, y `runPi` solo llama y pasa. La revisión del orquestador verifica el diff de `serve-rls.ts`: provider instanciado una vez, `runPi` lo consulta por request, cero llamadas a Fabric fuera del provider.

**T5 — Precedencia y determinismo, end-to-end por `runSpec`** (mismo arnés que `tests/stale-degradation.test.ts`: spec YAML en tmpdir + capability mock inyectada por `extraCapabilities` que devuelve filas fijas; el `asOf` entra por el campo nuevo de `RunOptions`).
Hecho cuando en `tests/header-as-of.test.ts` pasan: (a) spec CON `quality.freshness` resuelta + `asOf` param → el header muestra la watermark (gana D1.1), no la ingesta; (b) spec SIN freshness + `asOf` param con cutoff → muestra la ingesta; (c) spec sin freshness y sin param → `corte no disponible`; (d) **determinismo**: dos `runSpec` consecutivos del mismo spec/dato → `out1.html === out2.html` (byte-idéntico) — es el experimento que refuta D3 si queda otra fuente de no-determinismo.

Comando integral del frente: `npx vitest run tests/as-of-derive.test.ts tests/header-as-of.test.ts` y después los tres gates.

## Reglas duras

1. **No tocar la franja de #114**: nada de chips de filtros, nada del cuerpo del PI, nada de la bandeja (`tray`). Si un cambio «conviene de paso», no va.
2. **No tocar enforcement/policy/authz**: `packages/policy`, `serve-rls` fuera de la zona declarada, `pi-authz`, gates de gobernanza de `discovery.ts`.
3. **No tocar `server/admin.ts` ni `server/admin-*.ts`** (fuera de territorio; además su revisión dispara un safeguard conocido del harness).
4. **No tocar el banner de staleness** (`staleBanner`) ni la semántica de `checkFreshness` (solo se **agrega** `watermarkRaw`; ningún veredicto cambia — `tests/freshness*.test.ts` y `tests/stale-degradation.test.ts` deben pasar sin editarse).
5. **No editar specs de instancia ni configs desplegadas**; los specs de prueba se crean dentro de los tests.
6. Comandos destructivos (kill, limpieza) acotados al worktree propio, por ruta.

## ¿Quién juzga?

Los tres gates (`npm run typecheck` && `npm test` && `npm run build`) + los dos tests nuevos en verde + revisión del diff por el orquestador contra este documento (en particular: extinción total de `generatedAt`, paridad de themes, y que `serve-rls.ts` solo tenga el cableado declarado). Gate humano posterior (fuera de este frente): validación visual del header en la instancia GH al desplegar.

## Riesgos

- **Latencia del primer render** (miss de caché → llamadas REST a Fabric por proceso): acotada por el timeout de 3 s del provider y el TTL de 60 s; a fallo, el PI se sirve igual con «corte no disponible». El costo estacionario es ~0 (caché caliente).
- **Corte `null` por un solo proceso desconocido** (regla D6.1): en instancias con procesos sin `engine` ref el header dirá «no disponible» aunque otros dominios se conozcan. Es la lectura honesta (un corte garantizado no se puede afirmar con un insumo ciego) y es fail-visible: empuja a registrar el `engine` ref, no a maquillar. Registrado como decisión, no como bug.
- **Determinismo (T5.d)**: la evidencia del issue midió que el minuto del sello era la única diferencia entre renders, pero eso fue en la instancia GH con un PI concreto — el test lo re-verifica en el arnés; si aparece otra fuente de no-determinismo, se reporta al orquestador antes de relajar el assert (no se relaja en silencio).
- **Conflicto de merge con #114 en `arbol.ts`**: territorio disjunto (header vs cuerpo/bandeja) pero mismo archivo; lo resuelve el orquestador al integrar secuencialmente.
- **Miranda preview / CLI suelto**: renderizan sin param `asOf` → «corte no disponible» salvo watermark. Honesto y aceptado; no se cablea Miranda en este frente.

---

*Diseño: Fable (ww:wingcoding) · 2026-08-06 · cluster 002, ola B.*
