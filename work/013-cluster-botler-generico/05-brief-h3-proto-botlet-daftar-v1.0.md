---
doc_id: 013/05
cluster: 013-cluster-botler-generico
tipo: Brief ejecutable (Fable → realizador Opus)
issue: "#295"
hito: H3 — `packages/daftar`, el evaluador como Let; `invoke` en el Botler; Mira pasa por la misma puerta
version: 1.0
fecha: 2026-09-05
deriva_de: 01-diseno-rector (§3 B1 B3 B4, §4, §5 fila H3, §7) · D-68 (invoke diferido a H3) · D-72…D-75 (DECISIONS.md)
depende_de: H0 (#289) · H1 (#290) · H2 (#291), los tres en main (`042ecd2`)
gate: typecheck + suite + build + lint:shell · e2e local de un nodo con el Let Daftar: catálogo por identidad, intento guardado y leído, publicación de instrumento EN CALIENTE medida, 409 en standby medido, paridad 15/15 verificada por el realizador · banco v8 de Mira sin diferencia
---

# Brief H3 — Daftar como Let dentro del nodo, y la puerta de salida genérica del Botler

**Para el realizador.** Se ejecuta **en frío**. Si el terreno contradice el brief, detente y repórtalo en el informe final; no lo resuelvas por tu cuenta. Es el hito más grande del cluster: léelo dos veces antes de tocar nada.

## 0 · Reglas del repo que no se negocian

Las de §0 del brief H0 (`02-brief-h0-registro-proto-botlets-v1.0.md`). Concretamente:

```sh
cd /Users/cesar/wworkspace/productos/vergis
git fetch origin && git log --oneline -1 origin/main        # debe ser 042ecd2 o posterior (H1 mergeado)
git worktree add ../vergis-wt-h3 -b feat/botler-h3-proto-daftar origin/main
cd ../vergis-wt-h3
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm ci --ignore-scripts
```

Sin `git stash`. Los cuatro gates con salida real en el PR. Pie de commits y PR. No mergeas, no cierras issues. Normas 6 y 7. **Los datos de Daftar** (`/Users/cesar/wworkspace/estudios/daftar/app/{guides,progress,reports,static/preu}`) son de menores: se leen para las mediciones locales, **jamás** se copian al repo, al PR ni al informe; para tests y fixtures, contenido **sintético**.

## 1 · Qué se construye, en una frase

Un **segundo proto-Botlet, `daftar`** (`packages/daftar`), que hospeda **un Let evaluador** por instancia: sirve el catálogo de instrumentos del estudiante que entra, aplica un instrumento con el frontend actual de Daftar embebido, guarda cada intento en el store `evaluaciones` (con 409 cuando el nodo no controla), corrige, reporta e imprime — y, para que exista, **la puerta de salida del Botler se vuelve genérica**: `ProtoBotlet` gana `invoke`, el router despacha `/<slug>[/…]` por el proto del Let, y **Mira pasa por esa misma puerta** sin cambiar de conducta.

## 2 · El terreno, medido el 2026-09-05

### 2.1 · Lo que H0–H2 dejaron (verifícalo)

| Pieza | Dónde | Estado |
|---|---|---|
| Interfaz `ProtoBotlet` | `packages/botler/src/proto-botlet.ts` | `type · discriminator · parse · capabilitiesOf · dataOf · identityOf`. **Sin `invoke`** (D-68) |
| Registro | `server/proto-registry.ts` | `createProtoRegistry([...])`, `discriminate(text)` con 4 veredictos; regla de compatibilidad en `discovery.ts` |
| Mira como proto | `packages/mira/src/proto.ts` (`miraProtoBotlet`, objeto constante) | Solo descubrimiento |
| Descubrimiento | `server/discovery.ts` | **Omite una spec cuyo `capabilitiesOf` devuelve `[]`** (`caps.length === 0 → no servible`). Daftar no consume el DWH: esta regla lo mataría. Ver §3.2 |
| Router | `server/routes.ts` | Orden: healthz → gate token → `/contrato` → `/admin` → `/<slug>/config` → `/miranda` → `/impresiones` → gate `ready` → notas por PI → `/` índice → `/<slug>/pdf` → **slug-lookup final** `deps.renderReport(report, headers, nav)` |
| Render de Mira | `server/serve-rls.ts` `runPi()`/`renderReport()` (~l. 795-830) | Cierra sobre capabilities, notas, asOf, config |
| Índice y gate de artefacto | `serve-rls.ts` ~l. 967-1000: `indexReports` (ACL de PI o `visibleFor` por tablas — **un Let sin tablas es visible para todos**), `renderIndexPage`, `canOpenPi` (true sin ACL) | Genéricos por inyección |
| Salud por Let | `healthSummary` solo en `engine=fabric` (`piState` por slug); `piBlocked` devuelve «pendiente de verificación» para un slug sin estado | Un Let sin datos en fabric quedaría bloqueado para siempre. Ver §3.2 |
| Identidad | `server/identity.ts` `createIdentity(gateClaims, directory, dev)`; email del gate (`X-Forwarded-Email`) → claims desde `VERGIS_IDENTITY_MAP` (JSON `{ "<email>": { "<claim>": ["v"] } }`, semilla del store de gobierno) | Un claim nuevo (`student`) entra por el mismo mapa sin código nuevo |
| Store `evaluaciones` | `packages/capabilities/src/evaluaciones-{store,import}.ts` | `publicarInstrumento · guardarIntento · intento · intentosDe · bloquear · guardarRevision · reportes` · `exportarProgreso` reconstruye el JSON de Daftar · abre con `VERGIS_EVALUACIONES=1` |
| Hot-reload de specs | `serve-rls.ts` ~l. 2841: `contract.watch({envs, reloads}, targets, cb)` + `discovery.rebuild()` | El mismo mecanismo sirve para los instrumentos |
| Frontend de Daftar | `estudios/daftar/app/static/{index.html (62 l.), app.js (2.337 l.), style.css (1.213 l.)}` | `STUDENT` de `?s=`; `fetch` a `/api/students · /api/guides[/<id>] · /api/progress[/<id>] (GET/POST) · /api/reports[/<id>] · /api/reset/<id>`; imágenes del preu como `<img src="/preu/<dir>/qNN.png">` dentro del JSON de la guía; lightbox; modo foco contra `http://127.0.0.1:53131` (ultraGO, no se toca) |
| Servidor de Daftar | `estudios/daftar/app/server.py` (1.226 l.) | Rutas de §3.5; `render_report` (~l. 586-1226) y `render_print` (~l. 380-580) en Python; `STUDENT_INFO` (l. 24) |

### 2.2 · Números que fijan el alcance

- 60 guías (formato en `estudios/guia-json-daftar.md`; tipos de sección medidos: `multiple_choice 108 · reading 91 · free_text 60 · fill 51 · classify 35 · true_false 28 · compare 3 · highlight 3`), 80 PNG del preu en `static/preu/<dir>/`, 55 progresos, 3 reportes.
- Ninguna guía real trae todavía `"confidence": true`; el frontend ya lo soporta.

## 3 · Diseño (decidido; no se rediseña)

### 3.1 · La puerta de salida: `invoke` en `ProtoBotlet` (D-72)

`packages/botler/src/proto-botlet.ts` gana:

```ts
/** Lo que el nodo entrega a un Let al invocarlo. Es la FRONTERA entre el runtime y el dominio. */
export interface LetInvocation {
  /** Método HTTP en mayúscula. */
  method: string
  /** Ruta RELATIVA al Let: '' para `/<slug>`, 'api/guides' para `/<slug>/api/guides`. Sin query. */
  path: string
  /** Query string parseada (valores repetidos → último). */
  query: Record<string, string>
  /** Cabeceras del request (las del gate incluidas). */
  headers: Record<string, string | string[] | undefined>
  /** Cuerpo ya leído (solo para métodos con cuerpo; límite lo fija el nodo). */
  body?: string
  /** La identidad resuelta por el nodo (email + claims). El Let NUNCA la deriva por su cuenta. */
  identity: IdentityContext
  /** ¿Este nodo tiene el plano de control? Un Let en standby NO escribe. */
  hasControl: boolean
  /** Quién controla, para el 409. */
  activeHolder: string
  /** Prefijo de URL del Let (`/<slug>`), para que el HTML que emite enlace a sí mismo. */
  base: string
}

export interface LetResponse {
  status: number
  headers?: Record<string, string>
  /** Texto (HTML/JSON) o bytes (imágenes). */
  body: string | Uint8Array
}

export interface ProtoBotlet<Spec = unknown> {
  … lo de H0 …
  /**
   * ¿Esta familia consume datos gobernados del motor (SQL, tablas, RLS)? `true` = Mira: se exige que
   * sus capabilities estén en el catálogo de serving y se aplica el gate de gobernanza por tabla.
   * `false` = el Let no toca el DWH: no hay tablas, no hay gate de gobernanza, es visible para toda
   * identidad y su autorización la decide él mismo en `invoke` (D-73).
   */
  readonly consumesData: boolean
  /**
   * Atiende un request dirigido a un Let de esta familia. Devuelve `null` si la ruta no es suya
   * (el nodo responde 404). Toda escritura que reciba con `hasControl === false` la rechaza con 409
   * nombrando `activeHolder` — el nodo NO lo hace por él, porque solo el Let sabe qué rutas escriben.
   */
  invoke(spec: Spec, specPath: string, inv: LetInvocation): Promise<LetResponse | null>
}
```

**Mira pasa por acá** (`packages/mira/src/proto.ts`): `miraProtoBotlet` deja de ser una constante y pasa a **`createMiraProto({ render })`**, donde `render(specPath, inv) → Promise<string>` es lo que el nodo inyecta (hoy `renderReport`). Su `invoke`: `path === ''` y `GET` → `{ 200, text/html, render(...) }`; cualquier otra ruta → `null`. `consumesData: true`. El nodo construye `createProtoRegistry([createMiraProto({ render: (p, inv) => renderReport(reportBySpecPath(p), inv.headers, navFromUrl(...)) }), createDaftarProto({...})])`. **Regla de paridad:** el HTML que devuelve `/<slug>` de un PI de Mira es **byte a byte** el de antes (el banco v8 lo verifica con sus invariantes).

**Router** (`routes.ts`): la rama final de slug-lookup pasa a resolver `slug` como el primer segmento y `rest` como el resto; encuentra el `report`; aplica `piBlocked` y `canOpenPi` como hoy; y llama `deps.invokeLet(report, req, res, rest)` (inyectado). Las ramas Mira-específicas que hoy preceden (`/<slug>/pdf`, `/<slug>/config`, notas por PI) **se guardan con `report.proto === 'mira'`**: para un Let de otra familia esas rutas caen a `invokeLet`. `deps.renderReport` se conserva para `/` con un solo visible (que es Mira hoy) **solo si el visible es Mira**; si es otro proto, `/` redirige a `/<slug>` (302).

`serve-rls.ts`: `invokeLet` lee el cuerpo con `readBody(req, límite)` para métodos con cuerpo, arma la `LetInvocation` (identidad por `identityFor`, control por `plane.hasControl()`/`activeHolderLabel()`), busca `protos.byType(report.proto)` (agrega `byType` al registro), parsea la spec (cacheada por `specPath`+mtime, como hace el descubrimiento), llama `invoke`, escribe la respuesta; `null` → 404. Errores → 500 con `fail()`.

### 3.2 · Descubrimiento y salud de un Let sin datos (D-73)

- `discovery.ts`: si `proto.consumesData === false`, se salta la comprobación de capabilities y el análisis de tablas: `tables = []`, `databaseRefs = []`, y se registra igual (`Report.proto = 'daftar'`). Con `true`, nada cambia.
- `serve-rls.ts` `piBlocked`: en fabric, un `report` cuyo proto no consume datos devuelve `null` (sirve) y **no entra a `piState`**; `healthSummary` cuenta `total` sobre **todos** los reports descubiertos y `serving` = los de datos verificados + los sin datos (así `lets.total == lets.serving` sigue siendo el predicado y un Let Daftar cuenta como Let). En clickhouse no cambia nada.
- **Arranque sin DWH.** La instancia «estudios» no tiene motor de datos. Mide qué exige hoy `config.ts`/`serve-rls.ts` para arrancar (`VERGIS_ENGINE`, `VERGIS_CONNECTIONS`, `VERGIS_GATE_SECRET`, `VERGIS_ADMIN_SEED`…). Objetivo: **un nodo arranca con solo `VERGIS_SPECS_DIR` (un `daftar.yaml`), `VERGIS_INSTRUMENTOS_DIR`, `VERGIS_EVALUACIONES=1`, `VERGIS_IDENTITY_MAP` y `VERGIS_OUT`**, en `engine=clickhouse` sin conexiones, y sirve el Let. Si algo lo impide, el cambio mínimo que lo permita, **con test** («arranca sin conexiones cuando ninguna spec consume datos»), y dicho en el informe.

### 3.3 · La spec del Let: `daftar.yaml`

```yaml
daftar_version: "1.0"
identity:
  code: estudios                     # → slug /estudios
  display_name: "Daftar · Estudios"
estudiantes:                         # reemplaza STUDENT_INFO de server.py
  sebas:  { name: "Sebastián Obach", grade: "8° Básico" }
  vicky:  { name: "Victoria Obach",  grade: "2° Medio" }
  matias: { name: "Matías Obach",    grade: "4° Medio" }
```

`packages/daftar/src/proto.ts`: `createDaftarProto(deps)` con `type: 'daftar'`, `discriminator: 'daftar_version'`, `consumesData: false`, `parse` (YAML → objeto; valida `identity.code` y `estudiantes` con un validador a mano o `ajv` con `schema/daftar-spec.schema.json`, que también se agrega), `capabilitiesOf → []`, `dataOf → []`, `identityOf → { code, displayName }`, `invoke` de §3.5.

### 3.4 · Instrumentos, identidad y persistencia

**Instrumentos = archivos, en caliente.** `VERGIS_INSTRUMENTOS_DIR` (registrado con `contract.env`) con esta forma:

```
<dir>/guides/*.json        # las guías, formato intacto (id = nombre sin .json)
<dir>/recursos/preu/**     # los PNG que las guías referencian como /preu/…
<dir>/reports/*.json       # las devoluciones (formato intacto)
```

El Let lista `guides/` con caché por `mtime` (como `server.py` `_guide_cache`), y el nodo instala **un `contract.watch`** sobre `<dir>/guides` y `<dir>/reports` que invalida esa caché (mismo patrón que `watch:specs`; razón `watch:instrumentos`). **Publicar un instrumento es copiar el archivo**; el Let lo ve en el próximo request **sin reinicio** (se mide en §5). Un archivo que cambia de contenido con el mismo id: se sirve el nuevo **y se avisa una vez por id** en el log («instrumento X cambió de sha; una guía publicada es inmutable — publicar con id nuevo»); el registro en el store (`publicarInstrumento`) es idempotente por sha y ante conflicto solo loguea. Los reportes se sirven desde `reports/` tal cual (el store los conserva por H2 pero **el Let lee archivos**: D-75).

**Estudiante = login (B4).** El claim `student` viene del mapa de identidad:

```json
{ "matias.obach@gmail.com": { "student": ["matias"] },
  "ceo@ultrabase.net":      { "student": ["*"] } }
```

- `student: ["<key>"]` → ve **solo** las guías cuyo `student` es esa key (el campo sigue en el JSON hasta H4), sus progresos y sus reportes.
- `student: ["*"]` → **admin de Daftar**: ve todo, y puede elegir estudiante con `?s=<key>` — el único lugar donde `?s=` sobrevive. Sin `?s=`, ve el catálogo completo agrupado por estudiante.
- Sin claim `student` → **403** con una página que dice a quién pedirle acceso (nombra el email que entró). Sin `identity.user` (gate ausente) → 403 igual. **Nunca** se cae a un estudiante por defecto.
- En desarrollo local sin oauth2-proxy: `VERGIS_DEV_IDENTITY` (ya existe, fail-safe) inyecta el email; el mapa hace el resto.

**Persistencia = store `evaluaciones`.** El intento se guarda con `guardarIntento` a partir del mismo JSON que el frontend hace `POST` hoy (el importador de H2 ya tiene la conversión; **reutiliza `importarProgreso`/`exportarProgreso`**, extrayéndolos a una función pura si aún no lo están). `GET /api/progress/<id>` = `exportarProgreso`. `GET /api/progress` = todos los intentos del estudiante, en el mismo dict `{ <guideId>: {...} }` que hoy. Bloqueo (`locked`) → 403 en POST, como hoy. `guideId` del cuerpo ≠ URL → 400, como hoy. **Sin store abierto, el Let responde 503 con motivo** en las rutas de progreso y sigue sirviendo catálogo y guías.

### 3.5 · La superficie del Let (rutas relativas a `/<slug>`)

| Método · ruta | Qué hace | Escribe |
|---|---|---|
| `GET ''` | Shell del SPA: `index.html` con `style.css` y `app.js` **inline** (el nodo no sirve estáticos) y un `<script>` previo que inyecta `window.__DAFTAR__ = { base: '/estudios', student: 'matias' \| null, admin: bool, students: {...} }`. Con `?s=` y admin, `student` es el elegido | no |
| `GET api/students` | `estudiantes` de la spec | no |
| `GET api/guides` | Metadatos de las guías visibles (misma forma que `_list_guides`) | no |
| `GET api/guides/<id>` | La guía completa; **reescribe** `src="/preu/` → `src="<base>/recursos/preu/` al servirla (las guías no se tocan en disco); 403 si no es del estudiante | no |
| `GET recursos/preu/<dir>/<archivo>` | PNG desde `<dir>/recursos/preu/`, con `content-type` por extensión; **rechaza `..` y rutas absolutas** | no |
| `GET api/progress` · `GET api/progress/<id>` | Del estudiante en sesión (`exportarProgreso`) | no |
| `POST api/progress/<id>` | Guarda el intento. **409 si `!hasControl`**; 403 si bloqueado; 400 si `guideId` no coincide; 403 si la guía no es del estudiante; 503 sin store | **sí** |
| `POST api/review/<id>` | Inyecta la revisión (`guardarRevision`). **Solo admin** (403 si no); 409 sin control | sí |
| `POST api/reset/<id>` | Borra el intento. **Solo admin** (en Daftar era «solo QA»); 409 sin control | sí |
| `GET api/reports` · `GET api/reports/<id>` | Del estudiante (o todos, admin) desde `<dir>/reports` | no |
| `GET report/<id>` | Reporte corregido en HTML (port de `render_report`) | no |
| `GET print/<id>` (`?blank=1`) | Guía con respuestas del estudiante para entregar al colegio (port de `render_print`) | no |

Todo lo demás → `null` (404 del nodo). El 409 lleva el texto del nodo: «Este nodo está en espera (standby): no tiene el plano de control… El nodo activo es <activeHolder>».

### 3.6 · El frontend, adaptado y embebido

`packages/daftar/assets/{index.html, app.js, style.css}` son **copias** del frontend actual con estos cambios, y solo estos:

1. `STUDENT` y `DEEPLINK_GUIDE`: `STUDENT = window.__DAFTAR__.student` (con `?s=` solo si `admin`); `g` sigue de la URL.
2. Toda `fetch("/api/...")` y `fetch(\`/api/...\`)` pasa por `const BASE = window.__DAFTAR__.base` → `${BASE}/api/...`. Son ~10 sitios (l. 53, 302, 310, 317, 357, 470, 632, 739, 785, 803 al 2026-09-05).
3. Enlaces a `/report/<id>` y `/print/<id>` → `${BASE}/report/...`.
4. `loadStudentInfo()` usa `window.__DAFTAR__.students`.
5. Nada más: ni el modo foco, ni la confianza, ni el lightbox, ni los tipos de ejercicio. `style.css` **intacto**.

Un test recorre `app.js` y falla si queda un `fetch("/api` o `fetch(\`/api` sin `BASE`.

Los assets se embeben en build: `packages/daftar/src/assets.ts` los lee con `readFileSync` en tiempo de módulo **no sirve** en el bundle de esbuild; usa el **loader `text`** de esbuild (`--loader:.html=text --loader:.css=text --loader:.js=text` acotado a esa carpeta con `import shell from '../assets/index.html?raw'`... verifica qué soporta la versión pineada de esbuild y elige la vía que funcione en `npm run build` **y** en `vitest`; si hace falta un plugin de vitest, va en `vitest.config.ts`). Mide que `dist/serve-rls.mjs` contiene el `app.js`.

### 3.7 · `render_report` y `render_print`, en TypeScript

`packages/daftar/src/{report,print}.ts`: port **fiel** de las dos funciones de Python (`server.py` ~l. 380-580 y ~l. 586-1226), tipo de ejercicio por tipo. Fixtures sintéticas por cada uno de los 8 tipos, con un test por tipo que compara contra un HTML esperado **generado con el Python** (corre `python3` sobre la fixture sintética una vez, guarda el esperado en `tests/fixtures/daftar/esperado/*.html`, y el test compara normalizando espacios). Así la paridad es medida, no juzgada.

## 4 · Tests que este hito entrega

- `tests/proto-invoke.test.ts`: Mira por `createMiraProto` devuelve exactamente lo que `render` devuelve para `path ''`; `null` para otras rutas; el registro `byType`.
- `tests/routes.test.ts` (ampliar): slug-lookup con `rest`; `/<slug>/pdf` de un Let no-Mira cae a `invokeLet`; `/` con un solo visible no-Mira redirige.
- `tests/discovery.test.ts` (ampliar): un proto con `consumesData: false` y `[]` capabilities se descubre con `tables: []`; con `true` sigue omitiéndose.
- `tests/daftar-proto.test.ts`: parse de la spec (válida e inválidas), `identityOf`.
- `tests/daftar-let.test.ts` (store en memoria, instrumentos en un `mkdtemp` con guías sintéticas): cada fila de §3.5 con su brazo negativo (403 ajeno, 403 sin claim, 409 sin control, 400 mismatch, 403 bloqueado, 503 sin store, `..` rechazado, reescritura de `/preu/`, admin con `?s=`).
- `tests/daftar-frontend.test.ts`: ningún `fetch` absoluto a `/api`; el shell inyecta `__DAFTAR__` y embebe los tres assets.
- `tests/daftar-{report,print}.test.ts`: los 8 tipos contra el esperado del Python.
- `tests/daftar-hot-instrumentos.test.ts`: copiar una guía nueva al directorio → aparece en `api/guides` sin reconstruir nada (con el watch simulado o con el caché por mtime).

## 5 · El gate, en orden

1. Los cuatro gates + `npm run capacidades:cotejo` (esta vez **sí** hay capacidad nueva: fila `CAP-NN` para el Let Daftar y otra para `invoke`/`invokeLet` si el cotejo la pide).
2. **Control negativo obligatorio:** neutraliza el 409 de `POST api/progress` (que escriba sin control) y corre la suite: el test de standby debe ponerse rojo. Restaura sin stash.
3. **Banco v8 de Mira** (`preparar` → `v8` → `limpiar`; sin contenedores ajenos): 9/9 con invariantes, **idéntico a H0**. Es la prueba de que Mira pasa por `invoke` sin cambiar.
4. **e2e local del Let, un nodo**, fuera del repo, con datos reales solo en lectura:
   ```sh
   mkdir -p /tmp/h3/{specs,instr/guides,instr/recursos,instr/reports,out}
   cp <daftar.yaml de §3.3> /tmp/h3/specs/
   cp /Users/cesar/wworkspace/estudios/daftar/app/guides/*.json /tmp/h3/instr/guides/
   cp -R /Users/cesar/wworkspace/estudios/daftar/app/static/preu /tmp/h3/instr/recursos/
   cp /Users/cesar/wworkspace/estudios/daftar/app/reports/*.json /tmp/h3/instr/reports/
   printf '{"m@x.test":{"student":["matias"]},"admin@x.test":{"student":["*"]}}' > /tmp/h3/map.json
   VERGIS_SPECS_DIR=/tmp/h3/specs VERGIS_INSTRUMENTOS_DIR=/tmp/h3/instr VERGIS_EVALUACIONES=1 \
   VERGIS_IDENTITY_MAP=/tmp/h3/map.json VERGIS_OUT=/tmp/h3/out VERGIS_ADMIN_SEED=admin@x.test \
   node dist/serve-rls.mjs &
   ```
   Con `curl -H 'X-Forwarded-Email: m@x.test'`: `/healthz` → `lets: {total:1, serving:1}`; `/estudios` → 200 con `__DAFTAR__.student === "matias"`; `/estudios/api/guides` → solo las 2 de matias; `/estudios/api/guides/051-…` → 200 con `src="/estudios/recursos/preu/`; un PNG → 200 `image/png`; `POST /estudios/api/progress/051-…` con un cuerpo válido → 200 y el `GET` lo devuelve igual; con `X-Forwarded-Email: nadie@x.test` → 403; sin cabecera → 403. **Publicación en caliente medida:** copia una guía sintética nueva con `student: matias` al directorio y pide `api/guides` **sin reiniciar**: aparece (anota los ms entre la copia y la primera respuesta que la lista). **Standby medido:** arranca un segundo nodo con el mismo `VERGIS_OUT` (el lease lo deja en standby) y haz el mismo `POST` contra él → **409 nombrando al activo**; `GET` → 200. Borra `/tmp/h3` al terminar.
5. **Paridad 15/15**, verificada por ti en el navegador contra `http://127.0.0.1:8080/estudios` con `VERGIS_DEV_IDENTITY` (o el curl con cabecera) y anotada como tabla en el PR: (1) catálogo agrupado por sprint y por materia · (2) abrir una guía · (3) `practice`: revisar sección, hasta 3 intentos · (4) `exam`: portada, cronómetro, corrección al final · (5) guardar y retomar el progreso · (6) confianza S·C·A con una guía sintética con el flag · (7) los 8 tipos de ejercicio renderizan · (8) imágenes del preu con lightbox · (9) `/report/<id>` · (10) `/print/<id>` y `?blank=1` · (11) reportes de devolución en el catálogo · (12) `locked` → 403 · (13) `guideId` mismatch → 400 · (14) reset solo admin · (15) modo foco: el código sigue intacto (no se puede medir sin ultraGO; **se declara sin medir**).

## 6 · CHANGELOG y catálogo

«Sin publicar», `###` propio citando **#295**, encabezando lo que ya está: **capacidad nueva** (segundo proto-Botlet, `invoke`, `VERGIS_INSTRUMENTOS_DIR`, claim `student`), lo que exige (nada para una instancia Mira: `invoke` es transparente, medido con v8), lo que se midió y lo que no (dos anillos con promoción y un intento a medias → **H5**; modo foco).

## 7 · Lo que NO se hace en H3

- No se migra contenido ni se mueve `student` fuera del JSON (H4). No se toca la instancia en soveria-host (H5). No `botler-ops` (H6).
- No se instancia la clase `Botler` de `packages/botler/src/botler.ts` (queda documentado en D-72: la puerta genérica es `ProtoBotlet.invoke`, no esa clase).
- No se cambia el DSL de Mira ni sus rutas `/config`, `/pdf`, notas: solo se guardan por proto.
- No se reescribe el frontend: se adapta en los puntos de §3.6 y nada más.
- No evaluación oral ni LLM.

## 8 · El informe final

Como §8 del brief H0, más: la tabla de paridad 15/15 con su veredicto por fila; los ms de la publicación en caliente; el cuerpo del 409 medido; qué exigió el arranque sin DWH (§3.2) y qué cambiaste; el resultado del banco v8; lo **sin medir**, con esas palabras.

---

*Doc 013/05 · Brief H3 · v1.0 · 5 de septiembre de 2026*

• *Generado con Wingworking*
