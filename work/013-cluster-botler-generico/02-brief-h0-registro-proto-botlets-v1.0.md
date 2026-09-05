---
doc_id: 013/02
cluster: 013-cluster-botler-generico
tipo: Brief ejecutable (Fable → realizador Opus)
hito: H0 — registro de proto-Botlets en el nodo
version: 1.0
fecha: 2026-09-05
deriva_de: 01-diseno-rector-botler-generico-daftar-v1.0.md (§3 B1, §4, §5 fila H0, §7 «discriminador ambiguo»)
gate: typecheck + suite + build + lint:shell verdes · banco de anillos v8 con 9/9 PIs servidos con contenido verificado · cero cambio de conducta
---

# Brief H0 — el nodo descubre y despacha por un registro de proto-Botlets

**Para el realizador.** Este documento se ejecuta **en frío**: no tienes la conversación que lo originó y no la necesitas. Todo lo que hay que saber está acá o en los archivos que se citan con ruta. Si algo del terreno contradice lo que dice este brief, **detente y repórtalo** en tu informe final en vez de resolverlo por tu cuenta: la contradicción es un dato para quien diseñó, no un obstáculo para rodear.

## 0 · Reglas del repo que no se negocian

1. **Rama + PR contra `main`. Jamás commit directo a `main`.** Nombre de rama: `feat/botler-h0-registro-proto-botlets`.
2. **Worktree propio**, fuera del árbol principal:
   ```sh
   cd /Users/cesar/wworkspace/productos/vergis
   git worktree add ../vergis-wt-h0 -b feat/botler-h0-registro-proto-botlets main
   cd ../vergis-wt-h0
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # node es keg-only en esta máquina
   npm ci --ignore-scripts
   ```
3. **`git stash` está prohibido**: `refs/stash` es del repositorio, no del worktree, y otro realizador puede estar trabajando en paralelo (ocurrencia W-01 nº 45, medida el 2026-09-03). Para un control negativo, copia el archivo a `/tmp` y restaura con `git checkout HEAD -- <archivo>`.
4. **Los gates son los tres de `CONTRIBUTING.md` más el de shell**, y su salida real va en el cuerpo del PR:
   ```sh
   npm run typecheck && npm test && npm run build && npm run lint:shell
   ```
5. **Commits** terminan con:
   ```
   Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01DiHC3rDxY8Bbh7DCUWG3pN
   ```
   y el cuerpo del PR termina con `🤖 Generated with [Claude Code](https://claude.com/claude-code)` y esa misma URL de sesión.
6. **No mergeas.** Entregas el PR con gates verdes y CI verde; el merge lo hace el orquestador tras verificar composición. **No cierras issues.**
7. **Norma 6 y 7 de la Ley (Constitución):** toda afirmación del PR o del CHANGELOG se verifica o se etiqueta «sin medir». Un mecanismo no se declara sin la corrida que lo habría refutado.

## 1 · Qué se construye, en una frase

El nodo de Vergis (`server/`) deja de saber que sus specs son de Mira: descubre y despacha a través de un **registro de proto-Botlets**, y Mira se registra como el primero. **La conducta observable no cambia en nada**: mismas rutas, mismo HTML, mismo `/healthz`, mismos logs salvo los dos nuevos que este brief nombra.

## 2 · El terreno, medido el 2026-09-05 (verifícalo antes de tocar)

| Pieza | Dónde | Estado |
|---|---|---|
| Descubrimiento de specs | `server/discovery.ts` | Importa `parseSpec` de `@vergis/mira` (que es `YAML.parse` pelado, `packages/mira/src/dsl/parse.ts`). Un texto que no parsea como YAML → `continue` en silencio. Luego lee `spec.data`, exige que toda `capability` esté en `servingCaps`, analiza tablas SQL, aplica gates de gobernanza, calcula `code`/`slug` |
| Render de un PI | `server/serve-rls.ts` líneas ~780-825: `runPi()` y `renderReport()` | `runSpec({ specPath, identity, ... })` de `@vergis/cli`/mira — una sola función de render, la de Mira |
| Router | `server/routes.ts` | `deps.renderReport(report, headers, nav)` en `/` (un solo visible) y en `/<slug>`; `deps.renderPdf` opcional. **No conoce a Mira**: ya es genérico por inyección |
| Interfaz `Botlet` y clase `Botler` | `packages/botler/src/{types,botler}.ts` | La clase `Botler` **no se instancia en el servidor**; el server importa del paquete solo tipos, `AppendOnlyLog`, `withResultCache`, `identityFromHeaders` |
| Discriminador de Mira | `schema/mira-spec.schema.json` línea 7 exige `mira_version`; `packages/mira/src/dsl/validate.ts:46` lo tipa | **14 de las 15** specs de `deploy/rollout/bench/specs/*.yaml` + `examples/*.yaml` lo traen; la que no es `examples/job-templates.yaml`, que no es un PI |
| Tests que tocan esto | `tests/discovery.test.ts` (construye `createDiscovery` con `specPaths`/`readSpec` inyectados), `tests/routes.test.ts`, `tests/standby-control.test.ts` | Hoy `createDiscovery` no recibe ningún parser: lo importa |

Corre estos tres comandos antes de escribir una línea y anota el resultado; son tu línea base:

```sh
npm run typecheck && npm test 2>&1 | tail -5        # anota el número de tests
grep -rn "parseSpec" server/ | grep -v test          # los llamadores que vas a re-cablear
grep -L 'mira_version' deploy/rollout/bench/specs/*.yaml examples/*.yaml
```

## 3 · Diseño (decidido; no se rediseña)

### 3.1 · La interfaz, en `packages/botler`

Archivo nuevo `packages/botler/src/proto-botlet.ts`, exportado desde `packages/botler/src/index.ts`:

```ts
/**
 * Un PROTO-BOTLET es la familia de Lets que el nodo sabe hospedar: sabe reconocer su spec, parsearla,
 * decir qué capabilities y qué tablas consume, e invocarla. El Botler (el nodo) NO entiende el dominio:
 * solo conoce esta interfaz. Mira es el primero; Daftar será el segundo (doc 013 del cluster homónimo).
 */
export interface ProtoBotlet<Spec = unknown, Output = unknown> {
  /** Nombre de la familia: `mira`, `daftar`. Es lo que `Report.proto` lleva y lo que el log nombra. */
  readonly type: string
  /**
   * Clave raíz que identifica una spec de esta familia (`mira_version`, `daftar_version`). El registro
   * discrimina por PRESENCIA de la clave en el YAML ya parseado, sin validar su valor.
   */
  readonly discriminator: string
  /** Parsea el texto de una spec. Lanza si no es de esta familia o está rota. */
  parse(text: string): Spec
  /** Capabilities que la spec consume (el catálogo de serving decide si es servible). */
  capabilitiesOf(spec: Spec): string[]
  /** Fuentes de dato de la spec, para el análisis de tablas y el gate de gobernanza. */
  dataOf(spec: Spec): { sql?: string; databaseRef?: string }[]
  /** Identidad de la spec: código estable (del que sale el slug) y nombre visible. */
  identityOf(spec: Spec): { code: string; displayName?: string }
}
```

**Nota de alcance:** `invoke`/`routes` **no** entran en H0. El render sigue siendo `renderReport` inyectado en el router (que ya es genérico); lo que H0 vuelve genérico es el **descubrimiento**. La invocación por tipo la trae H3 cuando exista un segundo proto que invocar — meterla ahora sería diseñar contra un solo caso.

### 3.2 · El registro, en `server/proto-registry.ts`

```ts
export interface ProtoRegistry {
  /** Los protos registrados, en orden de registro. */
  list(): ProtoBotlet[]
  /**
   * Decide a qué familia pertenece un texto de spec. Regla:
   *  - se parsea como YAML (`yaml`); si no parsea o no es un objeto → `{ kind: 'no-spec' }` (se omite,
   *    como hoy);
   *  - se buscan las claves discriminadoras de TODOS los protos entre las claves raíz;
   *  - exactamente una → `{ kind: 'ok', proto }`;
   *  - más de una → `{ kind: 'ambigua', protos: [...] }` — el llamador la OMITE y lo registra en el log
   *    (§7 del diseño: «rechaza specs con más de un discriminador y lo registra»);
   *  - ninguna → `{ kind: 'sin-discriminador' }`: el llamador aplica la regla de compatibilidad de §3.3.
   */
  discriminate(text: string): Discriminacion
}
export function createProtoRegistry(protos: ProtoBotlet[]): ProtoRegistry
```

Registrar dos protos con el mismo `type` o el mismo `discriminator` lanza en la construcción (es un error de cableado, no de operación).

### 3.3 · Compatibilidad: la spec sin discriminador

Hoy `discovery.ts` sirve cualquier YAML que parsee y cuyas capabilities estén en el catálogo, **aunque no traiga `mira_version`**. Una instancia real (A.R.B.O.L.) puede tener specs así en `/opt/mira/specs` y **no se puede medir desde acá**. Por eso, mientras el registro tenga **exactamente un** proto, una spec `sin-discriminador` se le atribuye a ese proto y se avisa **una vez por ruta** en el log:

```
[vergis-rls] '<ruta>' no declara `mira_version`: se asume Mira por ser el único proto-Botlet registrado. Declararlo — con dos familias registradas esta spec quedaría omitida.
```

Con dos o más protos registrados, `sin-discriminador` se omite con log. Esta regla **es la que garantiza cero cambio de conducta** y a la vez deja escrito el camino de salida. Cúbrela con test en los dos brazos.

### 3.4 · Mira como proto, en `packages/mira/src/proto.ts`

`export const miraProtoBotlet: ProtoBotlet<MiraSpecLike>` con `type: 'mira'`, `discriminator: 'mira_version'`, `parse = parseSpec` (más la comprobación de que el resultado es un objeto), `capabilitiesOf` = `Object.values(spec.data ?? {}).map(d => d.capability ?? '')`, `dataOf` = `[{ sql: d.params?.sql, databaseRef: d.params?.database_ref }]` por entrada, `identityOf` = `{ code: spec.identity?.code ?? spec.identity?.id ?? 'pi', displayName: spec.identity?.display_name }`. Exportado desde `packages/mira/src/index.ts`. **Es extracción literal de lo que hoy hace `discoverRaw()`**: compara línea a línea antes de dar por hecha la paridad.

### 3.5 · `discovery.ts` re-cableado

- `DiscoveryDeps` gana `protos: ProtoRegistry` (obligatorio). Se retira el `import { parseSpec } from '@vergis/mira'`.
- `Report` gana `proto: string` (el `type` del proto que la reconoció).
- `discoverRaw()`: por cada ruta → `protos.discriminate(text)` → según el `kind`: `no-spec` continúa en silencio (como hoy); `ambigua` continúa con log; `sin-discriminador` aplica §3.3; `ok` → `proto.parse(text)` (si lanza, log y continúa), luego **exactamente la lógica de hoy** (catálogo de serving, `analyzeSqlTables`, gate de gobernanza, `slug`, colisión de slug, `databaseRefs`, `specName`) leyendo de `capabilitiesOf`/`dataOf`/`identityOf`.
- El resto del archivo (`canAccess`, `visibleFor`, `diagnoseFor`, `withOverride`, `rebuild`) **no se toca**.

### 3.6 · `serve-rls.ts`

Una sola adición: construir el registro y pasarlo a `createDiscovery`:

```ts
import { miraProtoBotlet } from '@vergis/mira'
import { createProtoRegistry } from './proto-registry'
const protos = createProtoRegistry([miraProtoBotlet])
const discovery = createDiscovery({ store, engine: …, servingCaps: SERVING_CAPS, specPaths, protos, resolveBases: …, displayNameOverride: … })
```

Y en el `/contrato`, si es barato hacerlo derivado (no declarado): añadir al bloque que ya lista cosas del nodo un campo `protos: string[]` con `protos.list().map(p => p.type)`. Si exige más que unas líneas en `createContractRegistry`, **no lo hagas** y anótalo en el informe como dejado fuera.

`runPi`/`renderReport` **no cambian** en H0.

## 4 · Tests que este hito entrega

Nuevos (`tests/proto-registry.test.ts`):
1. `discriminate` con `mira_version` → `ok` con `proto.type === 'mira'`.
2. Texto que no es YAML válido → `no-spec`; YAML que es una lista o un escalar → `no-spec`.
3. YAML con `mira_version` **y** `daftar_version` (un proto ficticio de test con `discriminator: 'daftar_version'`) → `ambigua` con los dos tipos.
4. YAML sin ninguna clave discriminadora → `sin-discriminador`.
5. Registrar dos protos con el mismo `type` lanza; con el mismo `discriminator` lanza.

Adaptados y ampliados (`tests/discovery.test.ts`): la fábrica `mk()` pasa `protos: createProtoRegistry([miraProtoBotlet])`; todos los tests existentes siguen verdes **sin cambiar sus aserciones**; se agregan:
6. Con **un** proto, una spec sin `mira_version` se descubre igual y el log contiene «se asume Mira» exactamente una vez para esa ruta aunque `discover()` se llame dos veces (memo) — y **una vez más tras `rebuild()`** es aceptable; documenta cuál de los dos ocurre.
7. Con **dos** protos registrados (el ficticio), la misma spec sin discriminador **se omite** y el log lo dice.
8. Una spec ambigua se omite con log; `discover()` no la lista.
9. `Report.proto === 'mira'` para lo descubierto.

Paridad de las specs reales (`tests/proto-mira-specs-reales.test.ts`): recorre `deploy/rollout/bench/specs/*.yaml` y `examples/*.yaml`; cada archivo con `mira_version` discrimina como `mira`; `examples/job-templates.yaml` discrimina como `sin-discriminador` (es la única sin la clave el 2026-09-05; si aparece otra, el test la nombra y falla — es deliberado).

## 5 · El gate, en orden, y qué se anota de cada uno

1. `npm run typecheck && npm test && npm run build && npm run lint:shell` — verdes. Anota el conteo de tests antes y después (debe subir en los que agregaste y en ninguno menos).
2. **Control negativo obligatorio:** neutraliza la regla §3.3 (haz que `sin-discriminador` se omita siempre) y corre la suite: **los tests 6 y la paridad de `job-templates` deben cambiar de veredicto**; si nada se pone rojo, el test no mide. Restaura con `git checkout HEAD -- <archivo>` (sin stash).
3. **Banco de anillos** (`deploy/rollout/bench/README.md`; exige Docker, disponible en esta máquina):
   ```sh
   sh deploy/rollout/bench/scripts/bench.sh preparar     # construye la imagen DE ESTE WORKTREE, 2 anillos
   sh deploy/rollout/bench/scripts/bench.sh v8           # promoción + smoke de los 9 PIs por el borde con contenido verificado
   sh deploy/rollout/bench/scripts/bench.sh limpiar
   ```
   Se exige **9/9** servidos con `invariantesFaltantes: []` en `.run/datos/` (el veredicto se lee del JSON, no de la consola). Pega el resumen en el PR. Si `preparar` falla por algo del entorno (puerto ocupado, imagen que no construye), repórtalo textual y **no** declares el gate cumplido. **No corras el banco si `docker ps --filter name=benchv14` muestra contenedores vivos que no son tuyos**: otro realizador podría estar midiendo; espera o repórtalo.
4. Lee el log del nodo del banco (`docker logs <anillo activo> 2>&1 | grep -c 'se asume Mira'`) y anota el número: con las 9 specs del banco trayendo `mira_version` debe ser **0**. Si no es 0, algo de la regla §3.3 está mal.

## 6 · CHANGELOG y catálogo

- `CHANGELOG.md` → sección **«Sin publicar»**, un `###` propio. No es capacidad nueva para el operador ni para el especificador: es refactor del núcleo. Redáctalo como lo que el operador necesita saber — **«nada cambia para una instancia; el único síntoma nuevo posible es la línea de log “se asume Mira” en specs sin `mira_version`, y qué hacer con ella»**. Cita el issue **#289**.
- Corre `npm run capacidades:cotejo`. Si exige una fila `CAP-NN` para tu `###`, agrégala en `docs/capacidades.md` con la fila siguiente disponible, describiendo la superficie (`Report.proto`, línea de log) — no inventes una capacidad que no existe.
- **No** subas la versión de `package.json` ni cortes tag: el corte es del orquestador.

## 7 · Lo que NO se hace en H0

- No se instancia la clase `Botler` en el server ni se pasa Mira por `Botler.register`. Queda para cuando exista `invoke` (H3).
- No se toca `routes.ts` salvo que el typecheck lo exija por el campo nuevo de `Report` (no debería).
- No se renombra `pis` → `lets` (es H1). No se toca la herramienta de anillos ni el Caddyfile.
- No se crea `packages/daftar` ni ningún store (H2/H3).
- No se cambia el DSL de Mira ni `validate.ts`.

## 8 · El informe final (lo que el orquestador necesita para verificar composición)

En este orden, corto:
1. Rama, PR (URL), commits.
2. Salida real de los cuatro gates (últimas líneas) y conteo de tests antes/después.
3. Resultado del control negativo (qué se puso rojo).
4. Resumen del banco: veredicto de v8 (`pisServidos`, `invariantesFaltantes`), conteo de «se asume Mira».
5. Lista de archivos tocados con una línea por archivo.
6. **Lo que contradijo al brief**, si algo lo hizo, y qué decidiste dejar fuera (§3.6 `/contrato`, por ejemplo).
7. Lo que quedó **sin medir**, con esas palabras.

---

*Doc 013/02 · Brief H0 · v1.0 · 5 de septiembre de 2026*

• *Generado con Wingworking*
