# Diseño #117 — Fail-closed ante la clave raíz AUSENTE en los YAML de instancia

> Contrato de delegación wingcoding: **Fable diseñó, Opus implementa en frío.** Este documento es
> autocontenido: todo lo que hay que saber está aquí o en las rutas exactas que se citan.
> Issue: <https://github.com/Gegolabs/vergis/issues/117> · Cluster 002.
>
> **Precedencia de fuentes:** este documento > issue #117 > código actual en `main` (`10393e0`).
> Si el código difiere de lo citado aquí (línea corrida por otro merge), manda la *descripción* del
> punto, no el número de línea: localizar por el patrón citado.

## ¿Qué pide el issue?

Que Vergis distinga **«el archivo declara cero X»** (lista/mapa vacío explícito — legítimo) de
**«el archivo no declara X»** (clave raíz ausente — el modo de falla de un `sed`/merge/`yq`/truncado
que rompió el YAML sin romper su sintaxis). Regla de cuatro puntos:

1. Env **no definido** → la config no se usa. Sin cambios.
2. Env **definido**, archivo parsea, **clave raíz ausente** → **error de arranque** nombrando
   archivo + variable + clave. En hot-reload → **rechaza el swap, conserva lo vigente, loguea error**.
3. Clave raíz **presente y vacía** (`groups: []`) → cero elementos, válido y silencioso.
4. Arranque exitoso → **log del conteo** cargado por cada config (baseline barato contra el desvío).

## ¿Qué hay hoy en el código? (inventario verificado, caso por caso)

Todo verificado leyendo el código en `main` (`10393e0`). Cada fila dice qué pasa HOY si el archivo
existe y parsea pero perdió su clave raíz.

| # | Env | Clave(s) raíz | Dónde se carga | Hoy, clave ausente → | Verificado en |
|---|---|---|---|---|---|
| 1 | `VERGIS_DOMAINS` | `domains` | `server/serve-rls.ts:389-390` → `parseDomainsConfig` | **colapsa a `[]`**: `if (raw === undefined) return []` | `packages/capabilities/src/domain.ts:34` |
| 2 | `VERGIS_INTAKE` | `slots` | `server/serve-rls.ts:391-392` → `parseIntakeConfig`; también `server/deployment-check.ts:103` | **colapsa a `[]`** | `packages/capabilities/src/intake.ts:124` |
| 3 | `VERGIS_MASTER_DATA` | `entities` | `server/serve-rls.ts:753-755` → `parseMasterDataConfig` | **colapsa a `[]`** | `packages/capabilities/src/master-data.ts:58` |
| 4 | `VERGIS_GROUPS` | `groups` | `server/serve-rls.ts:756-758` — cast SIN parser | **colapsa a `[]`**: `.groups ?? []` | `server/serve-rls.ts:757` |
| 5 | `VERGIS_PI_OWNERS` | `owners` | `server/serve-rls.ts:791-793` — cast SIN parser | **colapsa a `{}`**: `.owners ?? {}` | `server/serve-rls.ts:792` |
| 6 | `VERGIS_SOURCES` | `sources` (+ `tableSources`, `processes`, `processOutputs`) | `server/serve-rls.ts:768-775` — cast SIN validación; el seed consume `?? []` | **colapsa a cero siembras** | `packages/capabilities/src/governance-store.ts:368,377,379,388` |
| 7 | `VERGIS_DATASETS` | `datasets` | `server/serve-rls.ts:215-218` | `?? []` **pero** `length === 0` → `throw` — **ya falla cerrado** (sin distinguir ausente de `datasets: []`; mensaje con otro formato) | `server/serve-rls.ts:216-218` |
| 8 | `VERGIS_POLICIES` | `policies` **o** `entities`/`datasets` (forma entidad-canónica) | `server/serve-rls.ts:156-161` → `parsePolicyStore` | forma legacy con `policies` ausente → **mapa vacío silencioso** (`if (!Array.isArray(list)) return out`) → toda tabla queda sin política → **deny total con cara de sano** | `packages/policy/src/store.ts:57-59` |

**Fuera del alcance de este issue** (no son «YAML con clave raíz», documentado en D12):
`VERGIS_CONNECTIONS` (JSON, el objeto entero es el valor — un truncado rompe `JSON.parse` y ya es
ruidoso; `serve-rls.ts:186-197`), `VERGIS_IDENTITY_MAP` (JSON íntegro, ídem; `serve-rls.ts:368-370`),
y las **specs de PI** (otro contrato: por-artefacto, no config de instancia; ver observación O2).

### Hallazgo A — el `catch` que traga: hoy NI el archivo malformado tumba el arranque

El issue asume que los parsers de domains/intake/master-data «sí fallan cerrado» cuando la clave
existe pero no es lista. El `throw` existe, pero **todo el bloque de administración está envuelto en
un `try` cuyo `catch` loguea `administración deshabilitada: <msg>` y SIGUE ARRANCANDO**
(`server/serve-rls.ts:752` abre el try; `:1093-1095` es el catch). Es decir: hoy un `domains.yaml`
con `domains: "chatarra"` no tumba el proceso — apaga la superficie admin entera y el server sirve.
Ese catch existe para fallas de INFRA («no-fatal», comentario en `:717`), pero al envolver también la
carga de config convierte un archivo roto en una degradación silenciosa-ish. **Fail-closed exige
sacar la carga de config de ese try** (D5).

### Hallazgo B — hoy el hot-reload EVAPORA en caliente ante la clave ausente

`reloadDomainGovernance` (`server/serve-rls.ts:1293-1310`) hace validate-before-swap por archivo:
si el parse lanza, conserva (`catch` en `:1299` y `:1308`). Pero con la clave ausente el parser NO
lanza — devuelve `[]` — así que el swap procede y **vacía en caliente** los dominios/slots vigentes
(con un log informativo `0 declarado(s)`). Al hacer que los parsers lancen ante la ausencia (D2),
el catch existente pasa a conservar el estado sano **sin tocar la mecánica del reload**.

### Hallazgo C — un `domains.yaml`/`intake.yaml` declarado sin bloque admin hoy NI SE PARSEA al arranque

`parseDomainsFile()`/`parseIntakeFile()` corren al arranque solo dentro del bloque
`if (VERGIS_MASTER_DATA || ADMIN_SEED.length)` (`serve-rls.ts:751,761-763`). Una instancia que
declara `VERGIS_DOMAINS` sin data maestra ni admins arranca sin validar ese archivo (aunque el
hot-reload sí lo cargue después). La fase de carga de D5 valida TODO archivo declarado,
incondicionalmente.

### Experimento — comportamiento real de la lib `yaml` (Norma 7: corrida que refutaría)

Lib `yaml` **2.9.0** (la instalada en `node_modules/yaml`; el manifiesto pide `^2.6.1`,
`package.json:33`). Corrido en `node:22-alpine` (docker) contra esa copia exacta, 2026-08-06:

| Entrada | `YAML.parse(...)` devuelve | `doc.domains` |
|---|---|---|
| `''` (archivo vacío / truncado a nada) | `null` | — |
| `'# solo comentario\n'` | `null` | — |
| `'otra: 1\n'` (clave raíz perdida) | `{otra: 1}` | `undefined` |
| `'domains:\n'` (clave presente, valor nulo) | `{domains: null}` | `null` |
| `'domains: []\n'` (vacío explícito) | `{domains: []}` | `[]` |
| `'owners: {}\n'` (mapa vacío explícito) | `{owners: {}}` | `{}` |

Conclusiones que el diseño usa: **ausente = doc `null` o clave no presente** (`undefined` al leerla);
**vacío explícito = `[]`/`{}`** — perfectamente distinguibles. El caso `clave:` (valor `null`) es un
tercer estado: los parsers existentes ya lo rechazan como «debe ser una lista» (p.ej.
`domain.ts:35`), pero la familia `?? []`/`?? {}` HOY lo colapsa también (`null ?? []` → `[]`).
Se sella en D2. **Ojo**: la detección de ausencia debe mirar `doc == null || !(clave in doc)` sobre
un objeto plano — no `?? `, que confunde `null` con ausente.

## ¿Decisiones selladas?

**D1 — La regla del contrato es la del issue, sin recortes.** Los cuatro puntos de «¿Qué se pide?»
se implementan tal cual. Racional: es el contrato de configuración del motor (propiedad del
Producto), y el precedente ya existe en el propio código (`VERGIS_DATASETS`, `serve-rls.ts:218`).

**D2 — Cómo se distingue, con tres estados y dos errores.** Para cada archivo de config con clave
raíz `K` (lista o mapa):
- **Ausente** — `doc == null`, o `doc` no es objeto plano (escalar/lista), o `!(K in doc)` →
  `throw` «falta la clave raíz». Cubre archivo vacío, solo-comentarios, decapitado y raíz de tipo
  equivocado (verificado en el experimento).
- **Presente pero no del tipo esperado** — incluye `K:` con valor `null` → `throw` «debe ser una
  lista/un mapa», con remediación `K: []` / `K: {}`. Es el comportamiento vigente de los parsers de
  domains/intake/master-data, que se conserva; la familia `?? []` lo adquiere al ganar parser (D3).
- **Presente y vacío** (`[]`/`{}`) → cero elementos, válido, silencioso (salvo el conteo del log D11).

**D3 — Los tres configs sin parser ganan parser de primera clase.** `VERGIS_GROUPS`,
`VERGIS_PI_OWNERS` y `VERGIS_SOURCES` hoy se castean sin validación (filas 4-6 del inventario): un
item malformado hoy revienta dentro del seed SQL o siembra basura. Se crean en
`packages/capabilities/src/governance-config.ts` (archivo NUEVO):
- `parseGroupsConfig(doc: unknown): GroupSeed[]` — raíz `groups` (lista). Por item: `id` string que
  matchee `^[a-z][a-z0-9_-]*$` tras `trim().toLowerCase()` (el MISMO criterio que el seed aplica en
  `governance-store.ts:352-353` — así el error sale ANTES, nombrado, y no dentro del try de infra),
  `label` string (default `id`), `members` lista de strings opcional. NO normaliza emails ni aplica
  tombstones: eso sigue siendo del seed (regla dura R2).
- `parsePiOwnersConfig(doc: unknown): Record<string, string>` — raíz `owners` (mapa). Valores
  string no vacíos; cualquier otro tipo lanza nombrando la clave del PI ofensor.
- `parseSourcesConfig(doc: unknown): GovernanceSeed-subset` — raíz `sources` (lista, OBLIGATORIA —
  ver D4); `tableSources`/`processes`/`processOutputs` listas opcionales. Por item, exige los campos
  que el seed consume como obligatorios (`sources[]`: `id`, `label`, `oferta` strings;
  `tableSources[]`: `tableRef`, `sourceId`; `processes[]`: `id`, `label`, `sourceId`, `engine`
  opcional con `workspaceId`/`itemId`/`jobType` strings; `processOutputs[]`: `processId`,
  `tableRef`). `validateOferta` NO se duplica: sigue viviendo en el seed.
  Los tipos de retorno son los ya exportados por `governance-store.ts` (`GroupSeed`,
  `GovernanceSeed`, `:54`/`:313`). Racional: mismo patrón fail-closed que domains/intake/master-data
  (paridad de forma, criterio de excelencia), y sin él la distinción ausente-vs-vacío no tendría
  dónde vivir para estas tres configs.

**D4 — En `sources.yaml`, solo `sources` es obligatoria; las otras tres claves raíz son opcionales.**
`tableSources`/`processes`/`processOutputs` ausentes = vacío legítimo. Racional: cero procesos o
cero mapeos es un estado común y legítimo (instancia sin frescura declarada), y obligar
`processes: []` en toda instancia compra poco: el baseline del log (D11) imprime los CUATRO conteos,
así que la decapitación de un bloque secundario queda visible en el log del arranque. La clave que
«le da sentido» al archivo (lenguaje del issue) es `sources`.

**D5 — La carga de config de instancia sale del `try` de administración y se vuelve FATAL.** Se crea
`server/instance-config.ts` (archivo NUEVO) con una función pura e inyectable:

```ts
export interface InstanceConfig {
  entities: MasterDataEntity[]; groupSeeds: GroupSeed[]; domains: DomainDecl[]
  intakeSlots: IntakeSlot[]; sourceReg: GovernanceSeed /* subset fuentes */
  piOwners: Record<string, string>
  /** Solo las configs con env definido; para el log de conteos (D11). */
  summary: string
}
export function loadInstanceConfig(env: Env, readFile: (p: string) => string = ...): InstanceConfig
```

Por cada env de las filas 1-6 **definido**: lee el archivo, `parseYaml`, corre el parser (D2/D3) y
**envuelve cualquier error** como `Error` con el formato de D10 (env + ruta + mensaje del parser).
Env no definido → valor vacío del tipo correspondiente, y no aparece en `summary`.
`server/serve-rls.ts` la llama UNA vez a nivel de módulo, **antes** del bloque
`if (VERGIS_MASTER_DATA || ADMIN_SEED.length)` — un throw ahí es top-level y tumba el proceso
(mismo mecanismo que hoy usan `:168` o `:218`). El bloque admin consume los valores ya parseados
(deja de parsear él mismo); su `try/catch` (`:1093`) queda SOLO para fallas de infra (apertura de
stores, wiring Fabric), que conservan el contrato «no-fatal» vigente. La población de
`domainsCfg`/`intakeSlotsCfg`/`piOwners`/`stewardGroups` se queda donde está (dentro del bloque):
este issue cambia la *validación*, no quién consume qué (evita el scope creep de re-decidir el
gating del avatar «Gestión»).
Racional: sin esto, la regla 2 del issue es imposible — el throw del parser moriría en el catch de
infra (Hallazgo A).

**D6 — El policy store entra al alcance.** `parsePolicyStore`
(`packages/policy/src/store.ts:47`) gana el chequeo de ausencia: si el doc es `null`/no-objeto, o no
declara NINGUNA de `policies` | `entities` | `datasets` → `VergisError` código `root-missing`
(formato de errores ya vigente en ese paquete, `store.ts:35-37`). Si `policies` está presente pero
no es lista (incluye `policies:` nulo) → error de tipo (hoy: retorno silencioso de mapa vacío,
`store.ts:58-59`). Si `entities`/`datasets` están presentes pero con forma inválida (p.ej.
`entities:` nulo — `isEntityStore` devuelve false porque exige `Array.isArray`,
`packages/policy/src/entities.ts:79-82`) → error de tipo nombrando la clave. `policies: []` y
`entities: [] / datasets: []` siguen siendo válidos (mapa vacío deliberado). El chequeo aplica POR
ARCHIVO de `VERGIS_POLICIES` (se cargan varios, `serve-rls.ts:156-160`).
Racional: el issue lo dejó fuera de su «alcance sugerido», pero su regla («toda config declarativa
de instancia») lo incluye, y es la MISMA clase de bug: un `policies.yaml` decapitado hoy produce
deny total silencioso — sin fuga, pero con la instancia entera 503-por-PI y ningún mensaje que
nombre el archivo. La carga ya es fatal en arranque (top-level, `:161`) y ya conserva en hot-reload
(`:1318-1322`): solo falta que el parser lance. Costo: ~10 líneas + tests. Decisión separable si el
humano la rebota.

**D7 — `VERGIS_DATASETS` se alinea al formato común distinguiendo los dos casos.** En
`serve-rls.ts:215-218`: clave `datasets` ausente → mensaje de ausencia formato D10; presente y
vacía (`datasets: []`) → sigue siendo error (un nodo clickhouse sin datasets no tiene sentido; es
la excepción documentada a la regla 3) con mensaje: `engine=clickhouse: VERGIS_DATASETS (<ruta>):
'datasets' está vacío — un nodo clickhouse necesita al menos un dataset.` La detección de ausencia
usa el criterio D2 (no `??`).

**D8 — Hot-reload: el catch existente ES el mecanismo; se extrae la pieza para testearla.** Con D2,
`parseDomainsFile`/`parseIntakeFile` lanzan ante la ausencia y los catch de `:1299`/`:1308`
conservan y loguean `console.error` — exactamente lo pedido (y cierra el Hallazgo B). Para que el
comportamiento «rechaza y conserva» tenga test propio (no solo el del parser), la mecánica
try-parse/compare/splice/log de `reloadDomainGovernance` se extrae a `server/hot-reload.ts` como:

```ts
/** Validate-before-swap de una lista viva: si `load()` lanza, conserva `live` intacta,
 *  reporta con `err` y devuelve false. Si cambió, splice in-place + `log`. */
export function reloadLiveList<T>(live: T[], load: () => T[], label: string, reason: string,
  log?: (m: string) => void, err?: (m: string) => void): boolean
```

`reloadDomainGovernance` delega en ella para dominios y slots (conexiones no se toca: es JSON y otro
shape). El reload de políticas no cambia (ya conserva, `:1318-1322`). Los mensajes conservan el
texto vigente («recarga de dominios falló (…); dominios vigentes conservados: …»).

**D9 — Sin opt-out, para nadie.** No hay flag que restaure el colapso ausente→vacío. Racional: la
vía legítima de declarar «no hay» existe y es de una línea (`clave: []`), la migración de una
instancia sana cuesta minutos, y un escape convertiría el contrato en opcional — la clase de bug que
motiva el issue sobreviviría exactamente en las instancias que activaran el flag, que serían las
menos vigiladas. Si un despliegue real revienta por esto, la corrección correcta es el YAML de la
instancia, no un flag del motor (ver Riesgos).

**D10 — Mensajes de error exactos.** Dos capas, ambas en español:
- **Parser** (sin contexto de archivo): `` <config>: falta la clave raíz '<clave>' — un archivo
  declarado como config debe contenerla; para declarar «no hay», usa '<clave>: []'. `` (con `{}`
  para `owners`). Ejemplos literales:
  - `domains: falta la clave raíz 'domains' — un archivo declarado como config debe contenerla; para declarar «no hay», usa 'domains: []'.`
  - `intake: falta la clave raíz 'slots' — un archivo declarado como config debe contenerla; para declarar «no hay», usa 'slots: []'.`
  - `master-data: falta la clave raíz 'entities' — …usa 'entities: []'.`
  - `groups: falta la clave raíz 'groups' — …usa 'groups: []'.`
  - `pi-owners: falta la clave raíz 'owners' — …usa 'owners: {}'.`
  - `sources: falta la clave raíz 'sources' — …usa 'sources: []'.`
  - Policy store (VergisError `root-missing`): `El documento no declara ninguna clave raíz del policy store ('policies', o 'entities'/'datasets').` · remediación: `Para un store vacío deliberado, usa 'policies: []'.`
- **Envoltura de `loadInstanceConfig`** (contexto): `` <ENV> (<ruta absoluta>): <mensaje del parser> ``.
  Ejemplo completo en el arranque: `VERGIS_DOMAINS (/etc/vergis/domains.yaml): domains: falta la
  clave raíz 'domains' — …`. En hot-reload el mensaje viaja dentro del texto vigente del catch.
  Los prefijos de config (`domains:`, `intake:`, …) son los que los parsers existentes ya usan.

**D11 — Log de conteos al arranque exitoso.** Una línea, tras la fase de carga, SOLO con las configs
cuyo env está definido: `[vergis-rls] config de instancia: groups 4 · domains 5 · pi-owners 12 ·
sources 7 (tablas 9 · procesos 3 · salidas 2) · intake-slots 3 · master-data 2`. Un cero legítimo
queda visible (`domains 0`). `datasets` no va aquí (nunca puede ser 0) ni `policies` (su conteo ya
lo imprime el hot-reload y añadirlo al arranque es opcional-fuera-de-alcance). La línea la compone
`loadInstanceConfig` (`summary`) y la imprime `serve-rls.ts`.

**D12 — Fuera de alcance, con nombre.** (a) `VERGIS_CONNECTIONS` y `VERGIS_IDENTITY_MAP`: JSON cuyo
valor es el documento entero; el modo de falla del issue (parsea-pero-perdió-la-clave) no aplica
igual (`{}` explícito es su única forma vacía y es fail-closed aguas abajo: deny por perfil/claim
inexistente). (b) Specs de PI: contrato por-artefacto con su propio ciclo (discovery los omite con
motivo). (c) La población condicional de `domainsCfg` fuera del bloque admin (Hallazgo C, segunda
mitad) no se re-decide aquí. (d) El conteo de policies en el log de arranque.

## ¿Observaciones para el orquestador? (no son tareas)

- **O1**: el catch de `discovery.ts:76-77` (`catch { continue }`) omite EN SILENCIO una spec que no
  parsea — ni un log. Misma familia de silencio, otro contrato; candidata a issue propio.
- **O2**: la fila «`hoy el archivo X colapsa ausente→vacío`» del issue está verificada línea por
  línea en el inventario de arriba; los dos hallazgos (A y B) corrigen el modelo mental del issue
  sin contradecir su pedido.

## ¿Territorio exacto? (cruzado contra las tareas)

| Frente | Archivos |
|---|---|
| Parsers capabilities | `packages/capabilities/src/domain.ts`, `intake.ts`, `master-data.ts`, `governance-config.ts` (NUEVO), `index.ts` (exports) |
| Policy | `packages/policy/src/store.ts` |
| Server | `server/instance-config.ts` (NUEVO), `server/serve-rls.ts`, `server/hot-reload.ts` |
| Tests | `tests/domain.test.ts`, `tests/intake.test.ts`, `tests/master-data.test.ts`, `tests/governance-config.test.ts` (NUEVO), `tests/entity-store.test.ts`, `tests/instance-config.test.ts` (NUEVO), `tests/hot-reload.test.ts` |

**Reglas duras (intocables):**
- **R1** — `server/admin.ts` NO se toca (no lo necesita ninguna tarea; además hay una salvaguarda
  automática conocida que corta la revisión de ese archivo).
- **R2** — La semántica de siembra de `governance-store.ts` no cambia: upserts, tombstones
  (`mira_group_seed_removed`), `validateOferta`, normalizaciones. Los parsers nuevos validan FORMA;
  el seed sigue siendo el dueño de la semántica.
- **R3** — `VERGIS_CONNECTIONS`, `VERGIS_IDENTITY_MAP`, `swapRecordInPlace` y el reload de
  conexiones no se tocan (D12).
- **R4** — Ningún mensaje/log existente se reescribe salvo los listados en D7/D10; UI y mensajes en
  español.
- **R5** — No se altera la mecánica de watch/debounce ni `createCachedScanner`.

## ¿Tareas, orden y «hecho cuando»?

Secuencial T1→T5 (T1-T3 son independientes entre sí y podrían paralelizarse, pero T4 consume las
tres; con un solo ejecutor, en orden).

**T1 — Ausencia fatal en los tres parsers existentes.** En `domain.ts:34`, `intake.ts:122-124`,
`master-data.ts:56-58`: reemplazar el `(doc ?? {})` + `if (raw === undefined) return []` por la
detección D2 con los mensajes D10. `raw === null` y tipos no-lista siguen cayendo al error de tipo
vigente.
*Hecho cuando:* `npx vitest run tests/domain.test.ts tests/intake.test.ts tests/master-data.test.ts`
verde con estos casos (añadidos/modificados): clave ausente lanza nombrando la clave (para doc `{}`,
`null`/`undefined` y `{otra: 1}`); `domains: []`/`slots: []`/`entities: []` → `[]` sin error;
`domains: null` sigue lanzando «debe ser una lista». **Modificar** el test hoy llamado
«lista vacía / ausente → []» en `tests/domain.test.ts` (la mitad «ausente» invierte su aserción).

**T2 — Parsers nuevos de gobierno.** Crear `packages/capabilities/src/governance-config.ts` según
D3/D4, exportar en `packages/capabilities/src/index.ts`.
*Hecho cuando:* `npx vitest run tests/governance-config.test.ts` (NUEVO) verde con: ausente lanza
por cada clave primaria (`groups`, `owners`, `sources`); vacío explícito pasa
(`groups: []`, `owners: {}`, `sources: []`); en sources las tres claves secundarias ausentes pasan y
presentes-vacías pasan; item malformado lanza nombrando el campo (grupo con id fuera de slug, owner
con valor no-string, source sin `oferta`); `groups:` nulo lanza como error de tipo.

**T3 — Policy store.** Implementar D6 en `packages/policy/src/store.ts`.
*Hecho cuando:* `npx vitest run tests/entity-store.test.ts tests/policy.test.ts tests/governance.test.ts`
verde, con casos nuevos en `tests/entity-store.test.ts`: doc `{}`/`null`/`{otra:1}` lanza
`root-missing`; `policies: []` → mapa vacío; `policies:` nulo lanza tipo; `entities:` nulo lanza
tipo; los casos existentes de ambas formas siguen verdes sin editar los que no toquen esto.

**T4 — Fase de carga fatal + conteos + datasets.** Crear `server/instance-config.ts` (D5, D10, D11);
en `server/serve-rls.ts`: llamar `loadInstanceConfig` a nivel de módulo antes del bloque admin,
hacer que el bloque consuma sus valores (eliminando los casts de `:756-758`, `:768-775`, `:791-793`
y los parse de `:753-755`, `:761-763` — `parseDomainsFile`/`parseIntakeFile` quedan solo para el
hot-reload), imprimir `summary`, y aplicar D7 a `:215-218`.
*Hecho cuando:* `npx vitest run tests/instance-config.test.ts` (NUEVO, con env y `readFile`
inyectados — sin disco) verde: (1) env definido + archivo sin clave → lanza y el mensaje contiene
el ENV, la ruta y la clave; (2) env definido + `clave: []` → carga 0 y `summary` lo reporta;
(3) env no definido → ni error ni mención en `summary`; (4) summary compone los conteos de D11
(incluye los 4 de sources). Y `npx vitest run tests/serve-rls.test.ts` sigue verde.

**T5 — Hot-reload testeable.** Extraer `reloadLiveList` (D8) a `server/hot-reload.ts` y delegar en
ella los dos bloques de `reloadDomainGovernance`.
*Hecho cuando:* `npx vitest run tests/hot-reload.test.ts` verde con casos nuevos: `load()` lanza →
la lista viva queda INTACTA (mismos elementos y misma referencia), `err` recibió el mensaje y
devuelve `false`; `load()` ok con cambio → splice in-place (la referencia capturada ve lo nuevo) y
`log` con el conteo; `load()` ok sin cambio → ni log ni splice. Con T1 encadenado, el caso
integrador queda cubierto: un parser-que-lanza-por-ausencia pasado como `load` conserva lo vigente
— exactamente el contrato «hot-reload rechaza y conserva».

## ¿El juez?

Los tres gates del repo + los tests nuevos:

```sh
npm run typecheck && npm test && npm run build
```

**Nota de entorno (verificada):** en esta máquina no hay `node` en el PATH del shell no-interactivo
(se buscó en PATH, homebrew, nvm, volta, pnpm; el experimento YAML corrió en docker
`node:22-alpine` con Docker Desktop levantado a demanda). Si al ejecutor le pasa lo mismo, el
fallback es correr los gates en docker montando el repo:
`docker run --rm -v "$PWD":/app -w /app node:22 sh -c 'npm ci && npm run typecheck && npm test && npm run build'`
(el daemon se levanta con `open -a Docker` y se espera `docker info`).

## ¿Riesgos y nota de release?

- **R-A (nota de release obligatoria): un YAML de instancia desplegado sin su clave raíz dejará de
  arrancar tras este cambio.** Es el propósito del issue, pero convierte un despliegue «sano
  mentiroso» en uno caído. Antes de desplegar sobre una instancia viva, verificar cada archivo
  declarado: `grep -l '^<clave>:' <archivo>` por cada fila del inventario (o simplemente arrancar en
  staging). **Estado de los YAML de la instancia A.R.B.O.L.: NO verificado desde este repo —
  conjetura razonable que están sanos (el issue nace de esa instancia y menciona su gate de
  pre-commit), pero se verifica en el despliegue (skill `mira-ops`), no se asume.**
- **R-B (cambio de conducta a destacar):** config malformada que hoy degrada a «administración
  deshabilitada» pasará a tumbar el proceso (Hallazgo A → D5). Igual para archivos declarados que
  hoy ni se parseaban sin bloque admin (Hallazgo C). Ambos son el fail-closed pedido; van en la nota
  de release.
- **R-C:** `groups:`/`owners:`/`sources:` con valor nulo (clave sin contenido) hoy «funcionan» como
  vacío por el `??`; pasarán a error de tipo con remediación explícita (`usa []`). Incluido en R-A.
- **R-D:** un `policies.yaml` legacy decapitado hoy arranca (deny total); con D6 no arranca. Si el
  humano rebota D6, se elimina T3 sin tocar el resto (decisión separable).
- **R-E (riesgo de implementación):** al mover la carga fuera del try (T4), cuidar que el bloque
  admin no vuelva a leer los env crudos — el cruce territorio/tareas lo cubre, y
  `tests/serve-rls.test.ts` + `tests/deployment-check.test.ts` deben seguir verdes
  (`deployment-check.ts:100-105` reportará la ausencia de `slots` como finding de error sin cambiar
  su código: le llega por el throw nuevo de `parseIntakeConfig`).

---

*Diseño: Fable (rol diseñador, wingcoding) · 2026-08-06 · contra `main` `10393e0`. Verificaciones:
citas archivo:línea leídas en esta sesión; experimento yaml 2.9.0 corrido en docker; lo no
verificable está etiquetado conjetura.*
