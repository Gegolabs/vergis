# 004·01 · Diseño — delta del contrato operativo entre versiones — issue #139 Nivel 2

**Horizonte: implementable.** Contrato ejecutable completo para un Opus en frío. El Nivel 1
(`/contrato`, PR #141) está mergeado en `main`; este diseño construye encima sin tocar su semántica.

## ¿Qué se construye?

Que `GET /contrato` responda además **«¿qué cambió en el contrato operativo respecto de la versión
que corría antes en esta instancia?»** — para que desplegar una imagen nueva sea el momento en que
las reglas viejas del operador se invalidan solas. El mal que #139 combate es el manual-caché sin
invalidación; el N2 es la invalidación: el delta le dice al operador exactamente qué reglas suyas
quedaron obsoletas con la imagen que acaba de subir.

## Estado actual verificado

- **`GET /contrato` existe, solo admins.** Ruta interceptada en `server/routes.ts:84` (después del
  token del gate, antes del gate `ready`); el router pela el query string (`server/routes.ts:64`:
  `const url = (req.url ?? '/').split('?')[0]`), así que un `?desde=` llega al handler sin tocar el
  ruteo. Handler y gate de rol en `server/contract.ts:206-239` (405 si no-GET, 403 sin store de
  gobierno o sin rol admin).
- **El snapshot del contrato** (`ContractSnapshot`, `server/contract.ts:54-74`):
  `version · engine · startedAt · hotReload · watches[{envs,paths,reloads}] · signals[{signal,action}]
  · reloads{last,recent} · artifacts[+diskSha256,pending] · env{bootOnly,reloadableContent,unknown}
  · caveats`. Derivación de las clases de env en `snapshot()` (`server/contract.ts:174-181`):
  `reloadableContent` = unión de envs de los watches instalados; `bootOnly` = consumidas − reloadable;
  `unknown` = presentes con prefijo `VERGIS_`/`MIRANDA_` y jamás consumidas.
- **Principio rector del N1 — derivado, no declarado** (`server/contract.ts:5-9`): la misma llamada
  que instala el watch lo registra (`contract.watch`, `server/serve-rls.ts:1703,1721,1731`), la que
  lee la env la marca consumida (`registry.env`), `configEnvKeys` corre `configFromEnv` sobre un
  Proxy que registra accesos (`server/config.ts:309-330`). Los `caveats` son la única autoría, y
  viven colocados en el sitio del código que los posee (`server/serve-rls.ts:255,296,359`).
- **Fail-safe absoluto**: el contrato jamás afecta el serving (`server/contract.ts:11-12`; `record`
  se traga sus errores en `server/contract.ts:169-172`).
- **La versión es build-time y única**: `VERGIS_VERSION` desde el `package.json` raíz, horneada en el
  bundle, `null` = ausencia honesta (`packages/capabilities/src/version.ts:14`). Esquema **X.Y**
  (`CHANGELOG.md:4-5`). Hoy `package.json:4` dice `0.14.0` y el CHANGELOG llega hasta `0.14.0` — el
  N1 está en `main` sin release; N1 y este N2 pueden salir en el mismo release.
- **La imagen es genérica e instance-agnóstica** (`README.md:31`: «The image (`Dockerfile`) is
  generic and instance-agnostic: specs, policies, datasets and connections are injected via the
  environment»; `deploy/compose.reference.yml` cabecera: plantilla sin datos de instancia).
- **El único estado persistente por instancia es el volumen de `VERGIS_OUT`** — ahí vive
  `governance.sqlite` (compose: montaje `./governance:/governance`, env `VERGIS_OUT: /governance`) y
  el default de `VERGIS_NOTES_DB` (`CHANGELOG.md`, entrada 0.13.0). `config.outDir` lo resuelve con
  fallback a tmpdir (`server/config.ts:283`); `deployment-check` ya vigila que no sea efímero cuando
  hay gobierno (`server/deployment-check.ts:109-123`).
- **Cuándo se puebla el registro**: las lecturas de env ocurren durante la evaluación del módulo —
  incluidas las del bloque de administración, que usa top-level `await`
  (`server/serve-rls.ts:887-910`) y corre ANTES del `contract.record('boot')` del fondo del módulo
  (`server/serve-rls.ts:1694`). Lo único que queda asíncrono tras `listen` es `bootstrapAll()` del
  motor (`server/serve-rls.ts:1581-1593`). **Conjetura acotada**: no se encontró ninguna lectura de
  `contract.env` posterior a la evaluación del módulo, pero no se instrumentó una corrida que lo
  demuestre — el diseño no depende de ello (ver D4: captura convergente).
- **La proyección es branch-dependiente por diseño**: si Miranda está apagada sus claves no aparecen,
  «y es verdad, no se consumieron» (`server/config.ts:314-315`); los envs de un watch se derivan de
  qué archivos hay realmente (`server/serve-rls.ts:1734-1738`); con `VERGIS_HOT_RELOAD=0` no hay
  watches ni SIGHUP (`server/serve-rls.ts:1700,1746`). El contrato observado es el de ESTA instancia
  con ESTA config.
- **El issue pide** (cuerpo de #139, sección «Nivel 2»): «Qué cambió en el contrato de una versión a
  la siguiente. Requiere autoría, pero acotada: solo cuando el contrato cambia. Es lo que permite que
  desplegar una imagen nueva sea el momento de invalidar las reglas del operador que quedaron
  viejas.» Y nombra el costo asimétrico: la regla que ordena más cautela de la necesaria no falla
  nunca — solo cobra un corte de servicio cada vez.
- **Tests existentes**: `tests/contract.test.ts` (380 líneas; registro derivado, `configEnvKeys`,
  GET por el router real, aceptación «¿tomaste mi archivo?»). Gates del repo: `npm test` (vitest) y
  `npm run typecheck` (`package.json:13-19`).
- Diseño N1 de referencia: `work/003-cluster-solicitudes-2026-08-07/01-diseno-contrato-operativo-v1.0.md`
  (sus decisiones se citan como N1·D1…N1·D6).

## Decisiones selladas

### D1 — El delta se COMPUTA; la autoría entra solo por el código `[propuesta — revocable por César]`

El delta es el **diff estructural de dos proyecciones del contrato**: la de la versión que corre y
la persistida de la última versión distinta que corrió en esta instancia. **No hay changelog del
contrato mantenido a mano** — ni `.md` en la imagen, ni API `contract.note(sinceVersion, …)`, ni
sección autorada en el payload.

**Racional.** Un changelog del contrato autorado es exactamente la enfermedad que #139 combate — un
caché del comportamiento sin invalidación — solo que viviendo más cerca del código. Envejece por el
mismo mecanismo que el manual del operador: alguien tiene que acordarse de escribirlo en cada
release, y la entrada que falta no falla nunca. El caso de evidencia del issue es computable
completo: cuando `watch:policies` apareció, el delta computado habría dicho «watch nuevo: policies»
y «`VERGIS_POLICIES`: bootOnly → reloadableContent» — que es literalmente la invalidación de la
regla «restart solo por tabla gobernada nueva» que causó el corte.

**¿Y el «requiere autoría, pero acotada» del issue?** Se cumple, en el único lugar donde la autoría
no puede envejecer: **el código**. Los textos del contrato son autorados — el `reloads` de cada
watch (`server/serve-rls.ts:1704`), el `action` de cada señal (`:1746`), los `caveats` — pero viven
colocados junto a lo que describen, y su alta, cambio o baja **aparece sola en el delta** porque el
delta se deriva del mismo registro. Autoría solo cuando el contrato cambia, porque la autoría ES el
cambio en el código que registra el contrato. El issue se escribió antes de que existiera el N1; con
el snapshot completamente derivado, la parte «autorada» del N2 ya está pagada.

Se marca `[propuesta]` porque relee una frase literal del issue (cuya idea original es de César):
si César quiere además un canal de notas humanas por versión, la alternativa descartada es el
**híbrido anclado**: notas autoradas que solo son válidas si referencian una entrada del delta
computado (un gate rechaza la nota huérfana — no puede existir nota sin cambio mecánico que la
ancle). Es construible encima de este diseño sin rehacer nada; se descarta hoy porque el CHANGELOG
humano ya cubre el «por qué» (ver D8 y no-metas).

### D2 — La proyección diffable: el corte exacto entre contrato y ruido de instancia

Del snapshot, es **contrato de la versión** (estable entre boots, diffable):

| Campo | Se proyecta | Se descarta del campo |
|---|---|---|
| `watches` | `{envs, reloads}` | `paths` — son VALORES de env de la instancia (`/specs`, `/policies/...`) |
| `signals` | `{signal, action}` completo | — |
| `env` | `{bootOnly, reloadableContent}` | `unknown` — typos/deprecados de ESTA instancia, no de la versión |
| `caveats` | completo | — |

Es **ruido de instancia/runtime** (fuera de la proyección): `startedAt`, `reloads{last,recent}`,
`artifacts` (hashes, paths, loadedAt), `env.unknown`, `watches[].paths`. Y es **contexto** — ni
contrato ni ruido: `engine` y `hotReload` viajan en la entrada del journal (no en la proyección)
para poder detectar que la config de la instancia cambió entre referencia y presente (D4, D5).

Normalización determinista: arreglos ordenados (watches por `reloads`, envs y caveats
lexicográficos, signals por `signal`), dedup, serialización JSON canónica → `sha256` de la
proyección como huella de cambio.

**Racional.** El delta que el operador necesita es el del contrato **tal como aplica a su
instancia** — la proyección es branch-dependiente igual que el snapshot (verificado arriba), y eso
es correcto: las reglas que invalida son las reglas de ESTA instancia. El precio es que un cambio de
config puede colarse al diff; se paga con honestidad, no con magia: `contextChanged` (D5).

### D3 — El journal persiste en `<VERGIS_OUT>/contrato/journal.json`

La referencia de la versión anterior **no puede vivir en la imagen**: la imagen es genérica e
instance-agnóstica (verificado, `README.md:31`) y además la imagen nueva es la versión NUEVA — no
sabe qué corría antes en cada instancia. Vive donde vive el único estado persistente de la
instancia: el volumen de `VERGIS_OUT` (junto a `governance.sqlite`), resuelto con `config.outDir`
(`server/config.ts:283`).

```
<outDir>/contrato/journal.json
{
  "entries": [
    {
      "version": "0.15.0",
      "engine": "fabric",
      "hotReload": true,
      "firstBootAt": "2026-08-08T12:00:00.000Z",
      "lastBootAt": "2026-08-10T09:30:00.000Z",
      "boots": 3,
      "projectionSha256": "…",
      "projection": { "watches": […], "signals": […], "env": {…}, "caveats": […] }
    }
  ]
}
```

- **Una entrada por versión** observada en la instancia. Cap: se conservan las **30** más recientes
  por `lastBootAt` (la de la versión corriente jamás se expulsa). Archivos de YAML chicos y ~30
  entradas: el journal se mantiene en decenas de KB.
- **Referencia para el delta = la entrada con `lastBootAt` máximo entre las de versión ≠ actual.**
  Recencia, no orden semver: «qué corría antes acá» es una pregunta de historia de la instancia, y
  así los rollbacks quedan bien definidos — tras volver de 0.16 a 0.15, el delta de 0.15 es contra
  0.16 (dirección explícita en `reference`/`current`, D5).
- **Fail-safe absoluto, heredado del N1** (`server/contract.ts:11-12`): journal ilegible o corrupto
  → `console.error('[contrato] …')` y se parte de journal vacío (el archivo es estado derivable, se
  sobrescribe en la próxima persistencia); directorio no escribible → se loguea una vez y el delta
  responde con su `reason` (D6). Nada de esto toca el boot ni el serving. Escritura atómica:
  `journal.json.tmp` + `rename`.
- `VERGIS_OUT` efímero ⇒ journal efímero ⇒ cada boot es «primer registro». No se agrega policing
  nuevo: `deployment-check` ya advierte el `VERGIS_OUT` efímero con gobierno
  (`server/deployment-check.ts:109-123`), y `/contrato` exige admin, que exige gobierno (N1·D2) —
  un despliegue que puede consultar el delta ya tiene el volumen.

### D4 — Captura convergente: persistir al boot y refrescar por huella

Cuándo se escribe la entrada de la versión corriente:

1. **Al boot**, inmediatamente después del `contract.record({reason:'boot',…})`
   (`server/serve-rls.ts:1694-1698`): primera observación → merge/append + persistir. Obligatorio
   aunque nadie consulte `/contrato` jamás — si solo se persistiera en el GET, una instancia que no
   consulta no dejaría referencia para el próximo despliegue.
2. **En cada `GET /contrato`**: se recomputa la proyección; si su sha256 difiere del persistido para
   la versión corriente → merge + re-persistir. Huella igual ⇒ no se escribe nada (el GET típico no
   toca disco de journal).

Semántica del merge sobre la entrada de la versión corriente:

- **Contexto idéntico** (`engine` y `hotReload` iguales a los almacenados): **unión** — envs por
  clase se unen y luego `bootOnly := bootOnly∪ − reloadableContent∪` (la derivación del snapshot,
  `server/contract.ts:174-177`, re-aplicada sobre la unión); watches y signals se unen por identidad
  (D7); caveats se unen. La entrada converge al contrato más completo observado de esa versión —
  dentro de una versión el contrato real no se achica; un «encogimiento» aparente es una rama no
  tomada en este boot.
- **Contexto distinto** (el operador cambió `engine`/`hotReload` bajo la misma versión):
  **reemplazo** completo de proyección + contexto. Unir proyecciones de contextos distintos
  fabricaría un contrato que ninguna config produjo (p. ej. una clave a la vez bootOnly y
  reloadable).

**Racional.** Las lecturas de env parecen agotarse en la evaluación del módulo (verificado arriba,
con su conjetura etiquetada), pero el diseño no apuesta a eso: la convergencia por huella cuesta un
`sha256` por GET y hace la referencia inmune a cualquier lectura perezosa presente o futura. Es la
versión barata de no depender de un supuesto no medido.

### D5 — Exposición: sección `delta` en `GET /contrato`, más `?desde=<version>`

Mismo endpoint, mismo gate (N1·D1, N1·D2), claves en inglés y textos en español (N1·D3). El payload
del snapshot gana una sección `delta`, siempre presente:

```jsonc
"delta": {
  "current":   { "version": "0.16.0" },
  "reference": { "version": "0.15.0", "lastBootAt": "…", "engine": "fabric", "hotReload": true },
                                    // null si no hay referencia (con `reason`)
  "reason": null,                   // "primer-registro" | "version-desconocida" | "journal-no-disponible"
  "contextChanged": null,           // p.ej. { "hotReload": { "reference": true, "current": false } } —
                                    // aviso: parte del delta puede deberse a la config, no a la versión
  "unchanged": false,
  "changes": {
    "watches":  { "added": [{ "envs": ["VERGIS_POLICIES"], "reloads": "gobierno completo: …" }],
                  "removed": [], "modified": [] },
    "signals":  { "added": [], "removed": [], "modified": [] },
    "env": {
      "nowReloadable": ["VERGIS_POLICIES"],   // bootOnly → reloadableContent: YA NO exige restart
      "nowBootOnly":   [],                    // reloadableContent → bootOnly: AHORA exige restart
      "added":   [{ "key": "VERGIS_PDF_TIMEOUT_MS", "class": "bootOnly" }],
      "removed": [{ "key": "VERGIS_ANNOTATION_SECRET", "class": "bootOnly" }]
    },
    "caveats": { "added": ["…"], "removed": ["…"] }
  }
}
```

- **`nowReloadable` y `nowBootOnly` son de primera clase**, no un caso más de added/removed: la
  reclasificación bootOnly→reloadable es exactamente el costo asimétrico que el issue abre («la
  regla que ordena más cautela de la necesaria no se queja sola») — es EL dato que invalida reglas
  de operador, y se nombra solo.
- `unchanged: true` con `changes` en conjuntos vacíos también es información: «entre 0.15 y 0.16 el
  contrato operativo no cambió — tus reglas siguen vigentes» es una respuesta, no una ausencia.
- **`?desde=<version>`**: diffea la proyección corriente contra la entrada de esa versión del
  journal (auditoría, saltos multi-versión: «¿qué cambió desde la que corrimos en julio?»). Versión
  no registrada → **404** JSON `{"error": "La versión '0.9.0' no está en el registro de esta
  instancia.", "disponibles": ["0.14.0","0.15.0","0.16.0"]}`. El router ya pela el query del match
  de ruta (`server/routes.ts:64`), así que llega intacto al handler sin cambios en `routes.ts`.
- `modified` (watches/signals): `{ "before": {…}, "after": {…} }` con los objetos proyectados
  completos — el consumidor no reconstruye nada.

### D6 — Sin referencia: ausencia honesta, jamás fabricada

- **Primer boot con journal vacío** (instancia nueva, o primer release que trae el N2):
  `reference: null, reason: "primer-registro", changes: null`. No se inventa un delta contra la
  nada — el contrato completo del snapshot ES la lectura inicial del operador. Expectativa a
  documentar en el issue al cerrar: el primer release con N2 **siembra** el journal; el delta
  aparece desde el **segundo** despliegue.
- **`version: null`** (ausencia honesta del build, `packages/capabilities/src/version.ts:14`): no se
  escribe journal (dos builds sin versión serían indistinguibles y el merge fabricaría una entrada
  quimera) y el delta responde `reason: "version-desconocida"`.
- **Journal no disponible** (directorio no escribible/ilegible tras el fail-safe de D3):
  `reason: "journal-no-disponible"`, y el resto del snapshot se sirve intacto.

### D7 — Identidad de un watch para el diff (y para el merge de D4)

Los watches no tienen id; su identidad para emparejar referencia↔presente se resuelve en tres
pasadas deterministas, en orden, sobre los proyectados `{envs, reloads}`:

1. **Igualdad exacta** (`envs` y `reloads` idénticos) → sin cambio.
2. **Mismo conjunto `envs`** → emparejados como `modified` (cambió la descripción/semántica de la
   recarga — p. ej. «recarga políticas» → «gobierno completo: validate-before-swap + re-verificación»).
3. **Mismo string `reloads`** → emparejados como `modified` (cambió qué envs configuran el watch —
   p. ej. `VERGIS_INTAKE` se sumó al watch de gobierno de dominio).
4. Resto → `added` / `removed`.

Signals se emparejan por `signal` (clave natural); `action` distinto → `modified`. Caveats por
igualdad de texto (son frases estables autoradas en código; un reword aparece como removed+added, y
eso es aceptable: el texto ES el contrato del caveat).

### D8 — Por qué este delta no puede envejecer (la garantía estructural)

Cadena completa, sin memoria humana en ningún eslabón de release: el código registra el contrato en
las mismas llamadas que lo ejecutan (N1, imposible que driften) → la proyección es una función pura
del registro (D2) → el journal se escribe solo en cada boot (D4) → el delta es una función pura de
dos entradas del journal (D5). **No existe el paso «acordarse de actualizar el delta»** — el único
acto humano es cambiar el código del contrato, y ese acto es el que el delta reporta. Los textos
autorados (reloads/action/caveats) envejecen únicamente si el código que los posee envejece — y su
corrección aparece como cambio en el próximo delta, no como silencio.

El CHANGELOG humano (`CHANGELOG.md`) queda donde debe: el **porqué** y las instrucciones de
migración, citando el delta en vez de copiarlo. Generarlo desde el delta es no-meta.

## Arquitectura y contratos

### Módulo nuevo: `server/contract-delta.ts`

Puro salvo el journal (fs inyectable por dir; reloj inyectable como en
`createContractRegistry`, `server/contract.ts:116-119`).

```ts
import type { ContractSnapshot, SignalEntry } from './contract'

/** Proyección diffable del contrato (D2): SOLO lo estable entre boots de una versión. */
export interface ContractProjection {
  watches: { envs: string[]; reloads: string }[]      // sin paths; envs ordenados; watches por reloads
  signals: SignalEntry[]                              // ordenados por signal
  env: { bootOnly: string[]; reloadableContent: string[] }  // sin unknown; ordenados
  caveats: string[]                                   // ordenados
}

export interface JournalEntry {
  version: string
  engine: string
  hotReload: boolean
  firstBootAt: string
  lastBootAt: string
  boots: number
  projectionSha256: string
  projection: ContractProjection
}

export interface DeltaChanges {
  watches: { added: ContractProjection['watches']; removed: ContractProjection['watches']
             modified: { before: ContractProjection['watches'][0]; after: ContractProjection['watches'][0] }[] }
  signals: { added: SignalEntry[]; removed: SignalEntry[]
             modified: { before: SignalEntry; after: SignalEntry }[] }
  env: { nowReloadable: string[]; nowBootOnly: string[]
         added: { key: string; class: 'bootOnly' | 'reloadableContent' }[]
         removed: { key: string; class: 'bootOnly' | 'reloadableContent' }[] }
  caveats: { added: string[]; removed: string[] }
}

export interface ContractDelta {
  current: { version: string | null }
  reference: { version: string; lastBootAt: string; engine: string; hotReload: boolean } | null
  reason: 'primer-registro' | 'version-desconocida' | 'journal-no-disponible' | null
  contextChanged: Partial<Record<'engine' | 'hotReload',
                  { reference: string | boolean; current: string | boolean }>> | null
  unchanged: boolean
  changes: DeltaChanges | null
}

export const JOURNAL_RETENTION = 30

/** Proyección normalizada + determinista del snapshot (D2). Pura. */
export function projectContract(s: ContractSnapshot): ContractProjection
/** sha256 hex de la serialización canónica de la proyección. Pura. */
export function projectionHash(p: ContractProjection): string
/** Diff estructural (D5, D7). Pura; `changes` con conjuntos vacíos ⇒ el caller marca unchanged. */
export function diffProjections(reference: ContractProjection, current: ContractProjection): DeltaChanges

export interface ContractJournal {
  /** Merge/append de la observación corriente + persistencia atómica (D3, D4). Con `version: null`
   *  no escribe. JAMÁS lanza: todo error interno → console.error('[contrato] …') y no-op. */
  observe(snapshot: ContractSnapshot): void
  /** Delta contra la referencia por recencia (D3) o contra `desde` (D5). Pura sobre el estado en
   *  memoria; con `desde` no registrado devuelve null (el handler arma el 404 con `versions()`). */
  delta(snapshot: ContractSnapshot, desde?: string): ContractDelta | null
  versions(): string[]
}

export function createContractJournal(opts: { dir: string; now?: () => Date }): ContractJournal
```

- `createContractJournal` carga `<dir>/contrato/journal.json` una vez al construirse (corrupto ⇒
  vacío + log, D3) y mantiene el estado en memoria; `observe` compara huella y solo entonces escribe
  (tmp+rename). `dir` = `config.outDir`.
- `delta` sin `desde`: referencia = entrada de versión ≠ actual con `lastBootAt` máximo; sin
  candidatas → `reason: 'primer-registro'`. `contextChanged` compara `engine`/`hotReload` de la
  referencia contra el snapshot corriente y se emite solo si difieren.

### Cambios en módulos existentes

- **`server/contract.ts`** — `createContractHandler` gana el dep `journal: ContractJournal`
  (`server/contract.ts:206-211`). En el GET (tras el gate de rol intacto): `journal.observe(snap)`;
  parsear `desde` de `req.url` (`new URL(req.url, 'http://x').searchParams`); `delta === null` con
  `desde` ⇒ 404 con `disponibles: journal.versions()`; respuesta
  `{ ...snap, delta }`. El registry y su snapshot **no cambian** — el delta es capa de composición,
  no de registro.
- **`server/serve-rls.ts`** — crear el journal junto al registry
  (`server/serve-rls.ts:168`): `const contractJournal = createContractJournal({ dir: config.outDir })`;
  tras el `contract.record({reason:'boot',…})` de `server/serve-rls.ts:1694-1698`:
  `contractJournal.observe(contract.snapshot())` (D4·1); pasarlo al handler en el getter de
  `server/serve-rls.ts:703-707`.
- **`server/routes.ts`** — sin cambios (verificado: el match ya ignora el query,
  `server/routes.ts:64,84`).

### Semántica de errores y autorización (resumen)

| Caso | Respuesta |
|---|---|
| No-GET · sin gobierno · sin rol | 405 / 403 / 403 — intactos del N1 (`server/contract.ts:217-234`) |
| `?desde=` no registrado | 404 JSON con `disponibles` |
| Journal ilegible/no escribible | 200 con `delta.reason: "journal-no-disponible"` — el snapshot nunca se degrada por el delta |
| `version: null` del build | 200 con `delta.reason: "version-desconocida"`; journal intacto |
| Journal vacío (primer registro) | 200 con `delta.reason: "primer-registro"`, `changes: null` |

Reglas duras heredadas: el delta jamás expone valores de env ni secretos (la proyección solo lleva
NOMBRES y textos autorados — los paths de instancia quedan fuera por D2, más estricto que N1·D4);
todo error interno del journal se traga con log `[contrato]` (`server/contract.ts:11-12`).

## Plan de construcción

### H1 — Módulo puro + journal (`server/contract-delta.ts`)

**Territorio:** `server/contract-delta.ts` (nuevo), `tests/contract-delta.test.ts` (nuevo).

Tests mínimos (los que refutarían el mecanismo si estuviera mal — Norma 7):

1. **Replay del incidente 2026-08-07** (aceptación N2): proyección A sin watch de policies y con
   `VERGIS_POLICIES` en bootOnly vs proyección B con el watch ⇒ `changes.watches.added` lo contiene
   y `changes.env.nowReloadable === ['VERGIS_POLICIES']`. La regla vieja del operador queda
   nombrada obsoleta por el payload.
2. Reclasificación inversa ⇒ `nowBootOnly` (el costo asimétrico en ambas direcciones).
3. D7: reword de `reloads` con mismos envs ⇒ `modified` (no added+removed); cambio de envs con mismo
   `reloads` ⇒ `modified`; ambos distintos ⇒ added+removed.
4. Proyección: paths de watches, `unknown`, `artifacts`, `reloads{}` y `startedAt` NO aparecen;
   orden determinista (dos snapshots con arreglos permutados ⇒ misma huella).
5. Journal: primer `observe` crea archivo; segundo boot misma versión+contexto ⇒ unión (una env
   vista solo en el boot 1 sobrevive; `boots` incrementa); contexto cambiado ⇒ reemplazo (la unión
   quimera NO ocurre: una clave jamás queda en ambas clases); versión nueva ⇒ append y la referencia
   por recencia apunta a la anterior; rollback (0.16→0.15) ⇒ referencia = 0.16; cap 30 sin expulsar
   la corriente; archivo corrupto ⇒ vacío + no lanza; `version: null` ⇒ no escribe; dir no
   escribible ⇒ `observe` no lanza y `delta` reporta `journal-no-disponible`.
6. `unchanged: true` con proyecciones idénticas y referencia presente.
7. `desde` registrado ⇒ diffea contra esa entrada; no registrado ⇒ `null`.

**Hecho cuando:** `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx vitest run tests/contract-delta.test.ts`
verde y `npm run typecheck` limpio — sin pipes que enmascaren el exit code.

### H2 — Cableado y contrato HTTP

**Territorio:** `server/contract.ts` (handler), `server/serve-rls.ts` (journal + observe de boot),
`tests/contract.test.ts` (extender el patrón «GET /contrato por el router real»,
`tests/contract.test.ts:263`).

Tests de integración:

1. **Dos vidas, un journal**: registry v«0.15.0» (inyectando la versión vía snapshot de prueba o
   registry con envSource/now inyectados) → `observe` → registry v«0.16.0» con un watch más sobre el
   MISMO dir de journal ⇒ `GET /contrato` responde `delta.reference.version === '0.15.0'` y el watch
   en `changes.watches.added`. Nota: `VERGIS_VERSION` es import build-time
   (`packages/capabilities/src/version.ts:14`) — el arnés inyecta versiones construyendo
   `JournalEntry`s por `observe` de snapshots fabricados, no mockeando el módulo.
2. Primer GET de instancia virgen ⇒ `reason: 'primer-registro'` y el archivo queda sembrado.
3. `?desde=` feliz y 404 con `disponibles`.
4. El gate intacto: no-admin ⇒ 403 sin tocar el journal (el `observe` va tras el gate — un 403 no
   escribe disco).
5. GET repetido sin cambios ⇒ el journal no se reescribe (huella igual; verificable por mtime).

**Hecho cuando:** `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test` (suite completa) y
`npm run typecheck` verdes.

### H3 — Documentación de superficie

**Territorio:** `README.md` (la sección de operación donde se presente `/contrato` — verificado:
hoy `/contrato` no aparece en `README.md`, `docs/` ni `CHANGELOG.md`; el N1 se mergeó sin doc de
superficie, así que este hito documenta el endpoint completo N1+N2 en un solo lugar), y la entrada
de CHANGELOG del release que lo embarque (la escribe la sesión al releasear, citando el delta — no
la genera Opus).

**Hecho cuando:** `grep -n "/contrato" README.md` encuentra la sección con snapshot y delta.

**Juez de los tres hitos:** los gates del repo (`npm test`, `npm run typecheck`) + revisión del
orquestador del cluster contra este documento. Sin gate manual contra instancia viva: el delta no
toca motor ni red — el smoke real llega solo en el segundo despliegue con N2 (expectativa D6,
anotarla en el issue).

## Riesgos y no-metas

**Riesgos.**

- **Delta contaminado por cambio de config simultáneo** (imagen nueva + env editado en el mismo
  deploy): inherente a que la proyección es por-instancia (D2). Mitigación honesta: `contextChanged`
  para engine/hotReload; para el resto, el delta de envs added/removed refleja la suma de ambos
  cambios — el operador que editó el env lo sabe, y el payload nunca afirma «esto lo causó la
  versión». No se fabrica atribución que el sistema no puede medir.
- **Journal compartiendo volumen con `governance.sqlite`**: escritura atómica + tamaño acotado
  (cap 30) + fail-safe total; el journal es estado derivable — perderlo cuesta un
  «primer-registro», jamás datos.
- **Lecturas de env perezosas futuras** que engordarían la proyección después del boot: cubiertas
  por la convergencia de D4 sin depender de la conjetura de estabilidad (etiquetada en Estado
  actual).
- **N1 y N2 en el mismo release**: el primer despliegue solo siembra; el valor aparece al segundo.
  Riesgo de expectativa, no técnico — se declara en el comentario de cierre del issue.

**No-metas.**

- Changelog del contrato autorado, o notas humanas por versión en el payload (alternativa descartada
  en D1; reconsiderable por César).
- Generar `CHANGELOG.md` desde el delta, o validarlo contra él.
- Comparar contratos ENTRE instancias, o entre una instancia y una «versión canónica» de la imagen.
- Vista HTML del delta (N1·D3 sigue: JSON puro).
- Notificar el delta al operador al desplegar (push por email/Slack) — candidato natural para los
  canales de salida del frente 08 (#113/#100/#102) cuando existan; acá solo se deja el dato
  consultable.
- Persistir el historial de `reloads`/`artifacts` (runtime) en el journal: el journal registra
  contratos, no operación.
- Nivel 3 (Miranda encima) — frente 02 de este cluster; este payload es su insumo, no su tarea.

---
• 🤖 Claude (Fable) · diseño del frente #139 N2 · cluster 004
