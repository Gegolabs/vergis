# Diseño · Issue #100 — Aviso de ingestión: destino desacoplado de Slack + enlace y contexto en el mensaje

**Rol:** documento de diseño ejecutable (contrato de delegación wingcoding). El ejecutor arranca en frío: todo lo que necesita está aquí o en las rutas exactas citadas. Repo: `/Users/cesar/wworkspace/productos/vergis` (monorepo TypeScript; `packages/capabilities` = librería; `server/` = módulos de `serve-rls`; `tests/` = vitest).

**Issue:** [Gegolabs/vergis#100] — recortado el 2026-08-04: el monitor de alertas de frescura YA existe, está probado y config-gated (ver «Lo que ya existe» en el cuerpo vigente del issue). Este diseño cubre SOLO el delta: (1) destino de notificación desacoplado de Slack, (2) enlace profundo en el aviso, (3) dominio y hora esperada en el contenido.

**PRECONDICIÓN DE BASE (orden de olas):** este diseño se implementa sobre `main` + el diseño de **#105** ya ejecutado (`work/002-cluster-requests-2026-08/diseno-gh105.md`): el monitor vive en `server/freshness-loop.ts` (`createFreshnessLoop`, fase 2 «alertar») con su test `tests/freshness-loop.test.ts`. Si al implementar ese módulo no existe, DETENERSE: este documento no es ejecutable contra el monitor inline viejo de `serve-rls.ts`. El enlace a la página de corrida usa el formato sellado por **#99** (`work/002-cluster-requests-2026-08/diseno-gh99.md`, D5); si #99 aún no está desplegado en la instancia, el enlace apunta a una ruta que todavía no responde — es aceptable y transitorio (el orden recomendado de olas es #99 y #105 antes que #100).

**Coordinación con #102 (reporte periódico por email — se diseña APARTE, no aquí):** la abstracción de destino de este diseño (D1/D6) es la que #102 reusará. Por eso el puerto es de mensajes canal-agnósticos, no de «alertas de frescura»: #102 compone sus propios mensajes y los envía por los mismos sinks (o por uno de email que agregará él). Este diseño NO crea ningún sink de email.

---

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main`; el estado post-#105 se cita del diseño sellado de #105):

1. **El monitor existe y su anti-ruido es dedup por transición con estado persistido.** Hoy inline en `server/serve-rls.ts:1018-1070`: cada tick clasifica con `freshnessAlerts` (`packages/capabilities/src/ingestion-observability.ts:80`), dedupa con `diffAlertState` (`:101` — notifica SOLO cuando un proceso entra en alerta o cambia de razón; emite recuperación al salir) y persiste el estado en `platform_setting` clave `freshness.alert_state` solo en transición (`serve-rls.ts:1056-1060`), hidratado en el primer tick con `parseAlertState` fail-safe (`:1040-1043`). Ese estado sobrevive reinicios (#104, commit `b5e978f`). **Ese ES el rate-limit/dedupe: se hereda, no se agrega otro** (un proceso que sigue fallando no re-notifica jamás hasta recuperarse o cambiar de razón).
2. **El destino está casado con Slack en dos puntos:** el payload `{ text }` con mrkdwn (`serve-rls.ts:1025-1031, 1061-1062`: `:warning:`, `*…*`, backticks) y el gate de config `VERGIS_FRESHNESS_SLACK_WEBHOOK` (`:1021-1023`). El envío es at-most-once: `fetch` con `catch` → `console.error`; el estado se persiste ANTES de postear (`:1060` precede a `:1061`), así que un POST fallido pierde ese aviso (comportamiento vigente, se conserva — ver D7).
3. **El mensaje actual lleva `processId` + razón + `lastError` y NADA más** (`serve-rls.ts:1061`): sin dominio, sin hora esperada, sin enlace. `ProcessAlert` (`ingestion-observability.ts:70-77`) trae `processId`, `reason`, `ageSeconds`, `lastError?`.
4. **Todo el contexto que falta en el mensaje ya es derivable en el lazo:** `freshnessInputs()` (`serve-rls.ts:1003-1017`) devuelve `procs` (`ProcessRow { id, label, sourceId, engine? }` — `governance-store.ts:120-127`) y `sources` (`SourceRow { id, label, oferta, domain? }` — `:102-110`; el dominio de un proceso = `source.domain` de su fuente). La cadencia requerida por proceso sale de `deriveIngestionMap` (`freshness.ts:126-157`; el lazo usa `Infinity` para procesos fuera del mapa — `serve-rls.ts:1052`). `classifyProcess` (`ingestion-observability.ts:37-46`) da `lastSuccessAt` y `ageSeconds` — la hora esperada es `lastSuccessAt + requiredCadenceSeconds`.
5. **Las rutas destino del enlace existen solo para dominios DECLARADOS.** `admin.ts:155` resuelve `domainById` contra la config de dominios (`DomainDecl { id, label, stewards? }` — `domain.ts:14-26`, parseada de `VERGIS_DOMAINS`); un dominio tageado en la fuente pero no declarado en `domains.yaml` no tiene página. Frescura del dominio: `/admin/dominio/<id>/frescura` (`admin.ts:241,628`). Página de corrida (#99, sellada): `/admin/dominio/<id>/corrida?proc=<processId>&started=<ISO>` (diseño #99 D5, T5 — el ISO es el `startedAt` del `RunRecord` tal cual lo entrega el motor; #105 D2 garantiza que la proyección conserva esa misma cadena).
6. **No existe ninguna URL base pública en la config.** Grep de `PUBLIC_URL|baseUrl|publicUrl` sobre `server/` y `packages/*/src`: solo el `baseUrl` del transport de miranda (API Anthropic — otra cosa). Hay que introducirla.
7. **El patrón de config de instancia es YAML por archivo apuntado por env, validado fail-closed en el boot**: `VERGIS_DOMAINS`, `VERGIS_INTAKE`, `VERGIS_DATASETS` (`serve-rls.ts:396-398,221-224`), con parsers que LANZAN ante forma inválida (`parseDomainsConfig`, `domain.ts:31-52`) y `throw` a nivel de módulo (`serve-rls.ts:120,169,224,277`). El diseño sigue ese patrón.
8. **Nada más referencia el webhook viejo:** grep de `SLACK|webhook` en `tests/` y `docs/`: cero hits en tests; una fila en `docs/frescura-oferta-demanda.md:105` (se actualiza en T3). Eliminarlo no rompe nada fuera de lo editado aquí.
9. **Post-#105 (del diseño sellado, no de `main`):** la fase 2 del lazo recibe `postAlert?: (text: string) => Promise<void>` (apagada si `undefined`), sus `inputs()` devuelven `{ procs, mapInput }`, y los textos de Slack se copiaron tal cual del monitor inline. Los tres invariantes de #104 (hidratación en primer tick, persistencia solo en transición, `parseAlertState` fail-safe) son regla dura de #105 y de este diseño.

Conjeturas etiquetadas:

- **[Conjetura C1]** El formato `<url|label>` de enlaces mrkdwn es aceptado por los *incoming webhooks* de Slack vigentes en la instancia. Es el formato documentado histórico de mrkdwn; no se verificó contra un webhook vivo → gate manual G-M1.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — Puerto `NotificationSink` con mensaje canal-agnóstico `Notification`, en módulo nuevo `server/notify.ts`.**
El mensaje es estructura, no texto: `{ severity, title, lines, links, data }` (texto plano sin markup de canal; los enlaces con etiqueta; `data` con el evento estructurado). Cada sink RENDERIZA a su forma (D6). Racional: (a) es la costura que pide el issue — el producto compone UNA vez, el canal es intercambiable; (b) #102 la reusa componiendo sus propios `Notification` sin tocar los sinks; (c) va en `server/` (no en capabilities) porque los sinks hacen I/O (`fetch`) y sus únicos consumidores son módulos de server — la composición pura convive en el mismo módulo y se testea igual (todo `server/*` está bajo vitest).

**D2 — Config declarativa: `VERGIS_NOTIFY` = ruta a un YAML de destinos; REEMPLAZA a `VERGIS_FRESHNESS_SLACK_WEBHOOK` (que se elimina, sin alias de compatibilidad).**
Forma: `{ destinations: [{ id?, type: 'slack-webhook' | 'webhook', url }] }`, validada por `parseNotifyConfig` que LANZA ante forma inválida (patrón `parseDomainsConfig` — hecho 7): boot roto con mensaje claro, nunca un destino silenciosamente ignorado. Racional del reemplazo seco: pre-launch, criterio de excelencia — el env viejo codifica el acoplamiento que este issue elimina; mantenerlo como alias sería conservar la deuda con otro nombre. Nada externo lo referencia (hecho 8); encenderlo en una instancia es acto de instancia (fuera de alcance del issue).

**D3 — N destinos simultáneos: SÍ.** `createSinks(cfg)` devuelve una lista; el envío es fan-out con aislamiento por sink (cada `send` en `try/catch` con log `notify[<id>]: <error>`; un sink caído no bloquea a los demás ni tumba el tick). Sin retry: semántica at-most-once HEREDADA del monitor actual (hecho 2) — el dedup por transición hace que un aviso perdido no se re-emita, y ese trade-off ya es el vigente; endurecerlo (cola con retry) sería scope creep.

**D4 — URL base pública: env `VERGIS_PUBLIC_URL`; OBLIGATORIA cuando hay destinos declarados — sin ella el boot LANZA.**
`Error: VERGIS_NOTIFY declara destinos pero falta VERGIS_PUBLIC_URL (los avisos llevan enlaces absolutos a la vista de detalle).` Racional: el enlace es el requerimiento 2 del issue, no un adorno — fail-visible en el arranque (donde el operador está mirando), no un aviso mudo a las 7 de la mañana. Es env y no campo del YAML de notify porque es propiedad de la INSTANCIA (la usarán #102 y cualquier superficie futura que emita URLs hacia afuera), no del canal. Se normaliza sin slash final. Sin `VERGIS_NOTIFY`, la env es opcional e ignorada.

**D5 — Contenido del mensaje sellado: dominio + proceso (labels humanos), desenlace, motivo, edad, hora esperada, y enlaces profundos.**
Composición pura (`composeFreshnessAlert` / `composeFreshnessRecovery`, ver contratos) con estos elementos:

- **Título**: `Frescura — ⟨domainLabel⟩ · ⟨processLabel⟩: ⟨la corrida falló | atrasada (no corre a tiempo)⟩` (recovery: `: recuperado`). El label del dominio sale de `DomainDecl.label`; el del proceso de `ProcessRow.label` (un `processId` es identificador de máquina — el issue lo dice).
- **Motivo**: línea `motivo: ⟨lastError⟩` solo si viene (reason `failed`).
- **Edad**: `última corrida exitosa: hace ⟨fmtDur⟩ (⟨lastSuccessAt ISO⟩)` o `nunca ha registrado una corrida exitosa`.
- **Hora esperada**: `se esperaba una corrida antes de: ⟨ISO de lastSuccessAt + cadencia⟩ (cadencia requerida ⟨fmtDur⟩)`; si nunca corrió, `cadencia requerida: ⟨fmtDur⟩`. Se OMITE si la cadencia no es finita (proceso fuera del mapa — hecho 4). Instantes en ISO UTC: inequívoco para un webhook que puede reenviarse a cualquier zona; humanizar a zona local es problema del canal receptor, no del producto.
- **Enlaces**: `Ver corrida` → `⟨base⟩/admin/dominio/⟨domainId⟩/corrida?proc=⟨processId⟩&started=⟨startedAt⟩` (solo con reason `failed` Y corrida conocida — apunta al log de LA corrida que falló, #99); `Frescura del dominio` → `⟨base⟩/admin/dominio/⟨domainId⟩/frescura` (siempre que haya dominio; único enlace en `missed` — no hay corrida que mirar — y en recovery). Ambos con `encodeURIComponent` en query values.
- **Sin dominio enlazable** (fuente sin `domain`, o dominio tageado pero no declarado en `domains.yaml` — la ruta no existiría, hecho 5): título con `(sin dominio)` (o el id tageado como label de cortesía), CERO enlaces, y línea explícita `enlaces no disponibles: el proceso no pertenece a un dominio declarado`. Fail-visible: el aviso dice por qué no trae dónde mirar.

**D6 — Formato por canal: el sink Slack renderiza mrkdwn; el sink `webhook` postea el `Notification` como JSON declarado.**
Slack (`type: 'slack-webhook'`): `{ text }` con `:warning:`/`:white_check_mark:`/`:information_source:` según severity, `*título*`, líneas en texto plano y enlaces `<url|label>` separados por ` · `. Webhook genérico (`type: 'webhook'`): POST del objeto `{ severity, title, lines, links, data }` con `content-type: application/json` — payload DECLARADO y estable: es el contrato para que una instancia puentee a Teams/email/lo-que-sea sin que el Producto conozca el destino final. Respuesta ignorada; error → log (D3).

**D7 — Rate-limit/dedupe: se HEREDA el de #104 tal cual — dedup por transición con estado persistido (hecho 1). No se agrega ninguno.**
El orden vigente (persistir estado ANTES de postear) también se conserva: la alternativa (postear primero) re-notificaría todo ante un crash entre el POST y el persist — peor, porque el ruido entrena a ignorar la alerta (racional de #104).

**D8 — El lazo (#105) cambia su costura de aviso: `postAlert?: (text) => …` → `notify?: (n: Notification) => Promise<void>`, y gana el contexto para componer.**
`FreshnessLoopDeps.inputs` pasa a devolver también `sources` (el `freshnessInputs` de producción ya las devuelve — hecho 4, cero costo); deps gana `domains: { id, label }[]`; `FreshnessLoopConfig` gana `publicUrl: string`. La fase 2 compone con las funciones puras de `notify.ts` y llama `deps.notify(n)`. La semántica del gate no cambia: `notify` `undefined` ⇒ fase 2 apagada (ni computa ni persiste estado). Los textos del aviso CAMBIAN respecto de #105 (que copió los del monitor inline): es exactamente el objeto de este issue — los asserts de texto de `tests/freshness-loop.test.ts` son lo ÚNICO existente que se reescribe (ver T2 y reglas duras).

**D9 — `packages/capabilities/src/ingestion-observability.ts` queda EXACTAMENTE igual.**
`ProcessAlert` no se extiende: todo el contexto extra (labels, dominio, `lastSuccessAt`, cadencia, `startedAt` de la última corrida) ya está a mano en el lazo (hecho 4; la fase 2 tiene las corridas y el mapa) — se computa allí con `classifyProcess` (que ya se está llamando vía `freshnessAlerts`; re-llamarla para los pocos procesos notificados es O(notify), no O(procs)). Racional: la regla dura de #105 sobre ese módulo sigue valiendo, sus tests no se tocan, y la información contextual no es «salud del proceso» — es composición de mensaje.

**Cero preguntas abiertas.** Ambigüedad no prevista ⇒ resolver con el principio: fail-visible (el aviso o el boot dicen lo que falta, nunca callan), aditivo, y sin tocar las reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `server/notify.ts` (NUEVO — puerto, sinks, config y composición)

```ts
/**
 * Avisos salientes del producto (issue #100) — puerto de notificación DESACOPLADO del canal.
 *
 * El producto compone mensajes canal-agnósticos (`Notification`: estructura, no markup) y los envía
 * por N destinos declarados en la config de instancia (`VERGIS_NOTIFY` → YAML). Cada sink renderiza
 * a su forma: Slack (mrkdwn `{ text }`) o webhook genérico (el objeto JSON tal cual — contrato
 * declarado para puentear a cualquier canal sin que el producto lo conozca).
 *
 * Fan-out con aislamiento: un sink caído se loguea y no bloquea a los demás. Sin retry: at-most-once
 * (el dedup por transición del lazo de frescura hace el anti-ruido; un aviso perdido no se re-emite).
 * El reporte periódico (#102) REUSA este puerto componiendo sus propios `Notification`.
 */
import type { ProcessHealth } from '@vergis/capabilities'

export type NotificationSeverity = 'warning' | 'ok' | 'info'
export interface NotificationLink { label: string; url: string }
/** Mensaje canal-agnóstico: texto plano estructurado; el markup lo pone cada sink. */
export interface Notification {
  severity: NotificationSeverity
  /** Titular de una línea, sin markup. */
  title: string
  /** Cuerpo en líneas de texto plano. */
  lines: string[]
  links: NotificationLink[]
  /** Evento estructurado (los sinks de máquina lo reenvían tal cual). */
  data: Record<string, unknown>
}

export interface NotificationSink {
  id: string
  send(n: Notification): Promise<void>
}

// ── Config declarativa (VERGIS_NOTIFY → YAML) ──
export type NotifyDestinationType = 'slack-webhook' | 'webhook'
export interface NotifyDestination { id: string; type: NotifyDestinationType; url: string }
export interface NotifyConfig { destinations: NotifyDestination[] }

/** Valida `{ destinations: [...] }`. LANZA ante forma inválida (boot fail-closed, patrón domains). */
export function parseNotifyConfig(doc: unknown): NotifyConfig
// Reglas: `destinations` ausente ⇒ []; si presente, lista. Por ítem: `type` ∈
// {'slack-webhook','webhook'} (si no: Error `notify: destino #i con type inválido '…'`);
// `url` string no vacío que empieza por http:// o https:// (si no: Error `notify: destino #i sin
// url válida`); `id` opcional, default `⟨type⟩-⟨i+1⟩`, duplicado ⇒ Error.

/** Tipo del fetch inyectable (tests); default el global. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>

/** Sinks desde la config. `fetchImpl` inyectable para tests. */
export function createSinks(cfg: NotifyConfig, fetchImpl?: FetchLike): NotificationSink[]
// slack-webhook → POST { text: renderSlackText(n) }, content-type application/json.
// webhook       → POST JSON.stringify({ severity, title, lines, links, data }), mismo header.
// Ambos: la respuesta se ignora; el sink NO captura errores (el fan-out los aísla — ver fanout).

/** Render mrkdwn de Slack (exportada para tests). */
export function renderSlackText(n: Notification): string
// `⟨icon⟩ *⟨title⟩*` + `\n⟨line⟩` por línea + (si hay links) `\n` + links como `<url|label>`
// unidos por ` · `. icon: warning→':warning:' ok→':white_check_mark:' info→':information_source:'.

/** Fan-out con aislamiento por sink (D3). Nunca lanza. */
export async function fanout(sinks: NotificationSink[], n: Notification, log: (line: string) => void): Promise<void>
// for secuencial; catch por sink ⇒ log(`notify[⟨sink.id⟩]: ⟨mensaje del error⟩`).

// ── Composición de avisos de frescura (PURA — el lazo la invoca) ──
export interface FreshnessAlertContext {
  processId: string
  processLabel: string
  /** Dominio ENLAZABLE: id/label solo si la fuente lo tagea Y está declarado en domains.yaml. */
  domainId?: string
  domainLabel?: string
  reason: 'failed' | 'missed'
  lastError?: string
  /** Salud clasificada (classifyProcess) al momento del aviso. */
  health: ProcessHealth
  requiredCadenceSeconds: number
  /** startedAt (ISO del motor, tal cual) de la corrida más reciente — para el enlace a la corrida. */
  lastRunStartedAt?: string
  /** VERGIS_PUBLIC_URL normalizada (sin slash final). */
  baseUrl: string
}

export function composeFreshnessAlert(ctx: FreshnessAlertContext): Notification
export function composeFreshnessRecovery(
  ctx: { processId: string; processLabel: string; domainId?: string; domainLabel?: string; baseUrl: string },
): Notification

/** Duración humana aproximada (exportada para tests): ≥48 h → `⟨n⟩ d`; ≥90 min → `⟨n⟩ h`;
 *  ≥90 s → `⟨n⟩ min`; resto → `⟨n⟩ s`. n = Math.round de la unidad elegida. */
export function fmtDur(seconds: number): string
```

Semántica EXACTA de `composeFreshnessAlert` (los tests observan cadenas):

1. `severity: 'warning'`. `title`: `Frescura — ⟨domainLabel ?? '(sin dominio)'⟩ · ⟨processLabel⟩: ⟨reason === 'failed' ? 'la corrida falló' : 'atrasada (no corre a tiempo)'⟩`.
2. `lines`, en este orden y solo las que apliquen:
   - `motivo: ⟨lastError⟩` — si `lastError` viene.
   - `última corrida exitosa: hace ⟨fmtDur(health.ageSeconds)⟩ (⟨health.lastSuccessAt⟩)` — si `health.lastSuccessAt != null`; si no: `nunca ha registrado una corrida exitosa`.
   - Si `Number.isFinite(requiredCadenceSeconds)`: con `lastSuccessAt` ⇒ `se esperaba una corrida antes de: ⟨new Date(Date.parse(lastSuccessAt) + requiredCadenceSeconds*1000).toISOString()⟩ (cadencia requerida ⟨fmtDur⟩)`; sin él ⇒ `cadencia requerida: ⟨fmtDur(requiredCadenceSeconds)⟩`.
   - `enlaces no disponibles: el proceso no pertenece a un dominio declarado` — si `domainId` ausente.
3. `links` (vacío si `domainId` ausente): si `reason === 'failed'` y `lastRunStartedAt` presente ⇒ `{ label: 'Ver corrida', url: \`${baseUrl}/admin/dominio/${domainId}/corrida?proc=${encodeURIComponent(processId)}&started=${encodeURIComponent(lastRunStartedAt)}\` }`; siempre (con dominio) ⇒ `{ label: 'Frescura del dominio', url: \`${baseUrl}/admin/dominio/${domainId}/frescura\` }`.
4. `data`: `{ event: 'freshness-alert', processId, reason, ageSeconds: health.ageSeconds, lastError ?? null, expectedAt: ⟨el ISO del punto 2, o null⟩, domainId: domainId ?? null }`.

`composeFreshnessRecovery`: `severity: 'ok'`; `title`: `Frescura — ⟨domainLabel ?? '(sin dominio)'⟩ · ⟨processLabel⟩: recuperado`; `lines`: `[]` (o la línea de enlaces no disponibles si no hay dominio); `links`: solo `Frescura del dominio` si hay dominio; `data`: `{ event: 'freshness-recovery', processId, domainId: domainId ?? null }`.

### `server/freshness-loop.ts` (TOCAR — deltas sobre el módulo que crea #105)

```ts
// FreshnessLoopDeps — deltas:
//   - postAlert?: (text: string) => Promise<void>          ← se ELIMINA
//   + notify?: (n: Notification) => Promise<void>          ← undefined = fase 2 apagada (igual gate)
//   ~ inputs: () => Promise<{ procs: ProcessRow[]; sources: SourceRow[]; mapInput: DeriveMapInput }>
//   + domains: { id: string; label: string }[]              ← dominios DECLARADOS (para label y enlace)
// FreshnessLoopConfig — delta:
//   + publicUrl: string                                     ← ya normalizada, sin slash final
```

Fase 2 (alertar), delta de algoritmo — todo lo demás (hidratación primer tick, `diffAlertState`, persistencia solo en transición) queda EXACTO:

1. Para cada `ProcessAlert` de `notify` (lista de `diffAlertState`): resolver `proc = procs.find(p => p.id === a.processId)`; `source = sources.find(s => s.id === proc?.sourceId)`; `decl = source?.domain ? deps.domains.find(d => d.id === source.domain) : undefined`; `runsUsed` = las corridas con que se clasificó ese proceso en este tick (las observadas, o las proyectadas si la lectura falló — D11 de #105); `health = classifyProcess(runsUsed, req, now)` con `req = reqOf.get(a.processId) ?? Infinity`; `lastRunStartedAt` = `startedAt` de la corrida más reciente de `runsUsed` (orden por `Date.parse` desc), si hay.
2. `await deps.notify(composeFreshnessAlert({ processId: a.processId, processLabel: proc?.label ?? a.processId, domainId: decl?.id, domainLabel: decl?.label, reason: a.reason, lastError: a.lastError, health, requiredCadenceSeconds: req, lastRunStartedAt, baseUrl: cfg.publicUrl }))`.
3. Para cada `pid` recuperado: mismo lookup de proc/decl; `await deps.notify(composeFreshnessRecovery({ … }))`.

(`deps.notify` nunca lanza — es el `fanout`; aun así la fase queda dentro del `try` general del tick, como todo.)

### `server/serve-rls.ts` (TOCAR — wiring y config)

1. **Config, junto al resto de parses de instancia** (zona de `VERGIS_DOMAINS`/`VERGIS_INTAKE`, `serve-rls.ts:396-398` — la validación corre en el boot AUNQUE no haya engine: config inválida = boot roto siempre):

```ts
// Avisos salientes (issue #100): destinos declarativos + URL pública para enlaces profundos.
const notifyCfg: NotifyConfig = process.env['VERGIS_NOTIFY']
  ? parseNotifyConfig(parseYaml(readFileSync(resolve(process.env['VERGIS_NOTIFY']), 'utf8')))
  : { destinations: [] }
const PUBLIC_URL = (process.env['VERGIS_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '')
if (notifyCfg.destinations.length > 0 && !PUBLIC_URL)
  throw new Error('VERGIS_NOTIFY declara destinos pero falta VERGIS_PUBLIC_URL (los avisos llevan enlaces absolutos a la vista de detalle).')
```

2. **El wiring del lazo** (bloque que #105 deja en el lugar del monitor viejo): eliminar `freshnessSlack`/`postSlack` y el env `VERGIS_FRESHNESS_SLACK_WEBHOOK`; en su lugar `const sinks = createSinks(notifyCfg)` y pasar al lazo `notify: sinks.length ? (n) => fanout(sinks, n, (l) => console.error(\`[vergis-rls] ${l}\`)) : undefined`, `domains` (la lista ya parseada de `VERGIS_DOMAINS`), `inputs: freshnessInputs` (ya devuelve `sources` — hecho 4; solo se amplía el tipo del dep) y `publicUrl: PUBLIC_URL` en la config. Log de arranque: la parte de alertas pasa de `alertas ⟨Slack|off⟩` a `avisos ⟨n⟩ destino(s)` / `avisos off`.
3. **Comentario de cabecera de env** (`serve-rls.ts:19-30`): quitar `VERGIS_FRESHNESS_SLACK_WEBHOOK`; documentar `VERGIS_NOTIFY` (ruta YAML de destinos de aviso; sin él, avisos apagados) y `VERGIS_PUBLIC_URL` (URL pública de la instancia; requerida si hay destinos).

### `docs/frescura-oferta-demanda.md` (TOCAR — una fila)

La fila de `:105` («alerta autónoma … `VERGIS_FRESHNESS_SLACK_WEBHOOK`») pasa a describir el estado final: push por destinos declarativos (`VERGIS_NOTIFY`: Slack o webhook genérico, N simultáneos) con enlace profundo y contexto de dominio/hora esperada; dedup por transición. Sin rastros evolutivos.

### ¿Cómo se declara en la instancia? (referencia)

```yaml
# notify.yaml — destinos de aviso (VERGIS_NOTIFY=/ruta/notify.yaml; exige VERGIS_PUBLIC_URL)
destinations:
  - id: ops-slack
    type: slack-webhook
    url: https://hooks.slack.com/services/T000/B000/xxxx
  - id: puente-interno          # opcional: N destinos simultáneos
    type: webhook
    url: https://interno.example.com/hooks/vergis
```

```sh
VERGIS_PUBLIC_URL=https://mira.gh.example.com
```

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Orden: T1 → T2 → T3 → T4. Toda edición cae DENTRO del territorio de su tarea.

### T1 — Puerto, sinks, config y composición (`notify.ts`)

**Territorio:** crear `server/notify.ts`, crear `tests/notify.test.ts`.
**Hecho cuando:** `npx vitest run tests/notify.test.ts` verde, cubriendo como mínimo:

- `parseNotifyConfig`: doc vacío ⇒ `{ destinations: [] }`; destino válido con id default `slack-webhook-1`; `type` desconocido LANZA; `url` vacía o sin esquema http(s) LANZA; ids duplicados LANZAN.
- `renderSlackText`: un `Notification` warning con 2 líneas y 2 links produce EXACTAMENTE `:warning: *⟨title⟩*\n⟨l1⟩\n⟨l2⟩\n<u1|Ver corrida> · <u2|Frescura del dominio>`; ok ⇒ `:white_check_mark:`; sin links ⇒ sin línea final.
- Sinks con `fetchImpl` fake que captura `(url, init)`: `slack-webhook` postea `{ text }` a su url con `content-type: application/json`; `webhook` postea el JSON `{ severity, title, lines, links, data }` (deep-equal tras `JSON.parse`).
- `fanout`: primer sink lanza ⇒ el segundo recibe igual y el log capturó `notify[⟨id⟩]:`; nunca propaga.
- `composeFreshnessAlert` (cadenas selladas de D5/contratos): caso `failed` con dominio, `lastError`, `lastSuccessAt = 2026-08-05T00:00:00Z`, cadencia 86400, `lastRunStartedAt` ⇒ título exacto, línea `motivo:`, línea de edad, línea `se esperaba una corrida antes de: 2026-08-06T00:00:00.000Z (cadencia requerida 1 d)`, links `Ver corrida` (con `proc=` y `started=` URL-encodeados — usar un `startedAt` con `:` para observar el encoding) y `Frescura del dominio`, y `data.expectedAt` igual al ISO de la línea; caso `missed` nunca-corrió ⇒ `nunca ha registrado una corrida exitosa` + `cadencia requerida:` + SOLO link de Frescura; caso cadencia `Infinity` ⇒ ninguna línea de cadencia/esperada; caso sin dominio ⇒ `(sin dominio)` en título, `links: []`, línea `enlaces no disponibles:`; `composeFreshnessRecovery` ⇒ título `: recuperado`, severity `ok`.
- `fmtDur`: `90 → '90 s'`, `5400 → '90 min'`, `93600 → '26 h'`, `259200 → '3 d'`.

### T2 — El lazo compone y notifica (deltas de `freshness-loop.ts`)

**Territorio:** tocar `server/freshness-loop.ts` (deltas D8), tocar `tests/freshness-loop.test.ts` (el arnés cambia `postAlert` fake → `notify` fake que captura `Notification[]`; los asserts sobre TEXTO de los avisos se reescriben contra las composiciones nuevas — es lo único existente que se reescribe; los asserts de los invariantes #104 y de las fases 1/3 NO se tocan).
**Hecho cuando:** `npx vitest run tests/freshness-loop.test.ts` verde, cubriendo además de lo que ya cubría:

- Un proceso que entra en `failed` emite UN `Notification` cuyo título trae el LABEL del dominio y el LABEL del proceso (no los ids), con link `Ver corrida` apuntando a `⟨publicUrl⟩/admin/dominio/⟨dom⟩/corrida?proc=…&started=⟨startedAt de la corrida observada⟩` y link de Frescura.
- El dedup sobrevive intacto: el mismo proceso fallando en el tick siguiente NO re-emite (contar llamadas al fake); la recuperación emite el `Notification` de recovery con link de Frescura.
- Proceso cuyo source no tiene `domain` (o cuyo domain no está en `deps.domains`) ⇒ aviso sin links y con la línea `enlaces no disponibles:`.
- `missed` con historial ⇒ el aviso trae la línea `se esperaba una corrida antes de:` coherente con el reloj fake (`now` inyectado) y SIN link `Ver corrida`.
- `notify: undefined` ⇒ fase 2 apagada: no lee ni escribe `freshness.alert_state` (assert que ya existía con `postAlert`, re-apuntado).

### T3 — Wiring de producción y docs

**Territorio:** tocar `server/serve-rls.ts` (parse de `VERGIS_NOTIFY` + `PUBLIC_URL` + guard, wiring del lazo, cabecera de env), tocar `docs/frescura-oferta-demanda.md` (la fila de `:105`).
**Hecho cuando:** `npm run typecheck` y `npm run build` verdes; `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (esos tests no definen `VERGIS_NOTIFY`: cero destinos, `notify` undefined, nada cambia — regresión cero); `grep -rn "VERGIS_FRESHNESS_SLACK_WEBHOOK" server/ docs/ tests/` devuelve CERO hits.

### T4 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes, con `tests/notify.test.ts` nuevo incluido en `npm test`.

### G-M1 — Gate diferido/manual (instancia viva — NO es de CI; se declara, no bloquea el merge)

En la instancia GH (skill `mira-ops`): (1) declarar `notify.yaml` + `VERGIS_PUBLIC_URL`, provocar un fallo de ingesta y verificar que el aviso llega al canal Slack con los enlaces CLICABLES y que abren la corrida correcta ([Conjetura C1] sobre `<url|label>` en incoming webhooks); (2) verificar el boot roto con destinos sin `VERGIS_PUBLIC_URL` (mensaje claro en el log); (3) si hay un segundo destino webhook, verificar el JSON recibido contra el contrato de D6.

---

## ¿Qué NO se toca? (reglas duras)

- **`packages/capabilities/src/ingestion-observability.ts` queda EXACTAMENTE igual** (D9): ni `ProcessAlert` ni ninguna función. Sus tests tampoco.
- **Los tres invariantes de #104 se preservan EXACTOS** en el lazo: hidratación del estado en el primer tick, persistencia SOLO en transición, `parseAlertState` fail-safe. El orden persistir-antes-de-postear se conserva (D7). No se re-implementa el monitor: se cambia SOLO su costura de salida y la composición del mensaje.
- **No tocar la proyección de #105** (`ingestion_run`/`ingestion_process_state`, `recordObservations`, `listRunSnapshots`, fases 1 y 3 del lazo, debounce del reconcile): este diseño la CONSUME (las corridas de clasificación de la fase 2) sin modificarla.
- **No tocar el territorio de #99**: `run-logs.ts`, `admin-corrida.ts`, sus rutas y textos. El enlace se construye con su formato sellado (`/corrida?proc=…&started=…`), sin cambiarlo.
- **No diseñar ni implementar nada de #102** (sink de email, digests, cadencias de reporte): este diseño solo deja el puerto reusable.
- No tocar: `server/admin.ts`, `admin-cargas.ts`, `fabric-engine.ts`, `intake*.ts`, `freshness.ts`, `governance-store.ts`, `packages/policy`, miranda*, notas*, master-data*, engines de serving.
- No modificar tests existentes salvo lo declarado en T2 (`tests/freshness-loop.test.ts`: arnés de aviso + asserts de texto de aviso, nada más) y AGREGAR casos.
- Sin dependencias npm nuevas. Mensajes y UI en español; las cadenas selladas de D5/contratos se usan tal cual (los tests las observan).
- `VERGIS_FRESHNESS_SLACK_WEBHOOK` desaparece por completo (D2): sin alias, sin lectura muerta, sin mención en docs.
- Los sinks jamás lanzan hacia el tick (`fanout` aísla y loguea) ni mantienen vivo el proceso.

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/notify.test.ts` nuevo y los casos de `tests/freshness-loop.test.ts`. El síntoma (el aviso llega con dominio, hora esperada y enlace, por un canal declarativo no casado con Slack) lo observan T1/T2 con sinks y motor fake; su confirmación contra Slack vivo es G-M1 (diferido, declarado).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| Enlace a la página de corrida antes de que #99 esté desplegado (404) | Precondición de orden de olas declarada; el enlace de Frescura del dominio (ruta que ya existe) acompaña SIEMPRE; el 404 es transitorio y no miente. |
| Instancia con destinos pero sin URL pública ⇒ avisos sin dónde mirar | Boot LANZA con mensaje explícito (D4) — fail-visible donde el operador mira. |
| Un sink caído silencia a los demás o tumba el tick | `fanout` con catch por sink + log con el id (D3); test T1 lo encoda. |
| Aviso perdido por POST fallido (at-most-once) que el dedup nunca re-emite | Trade-off HEREDADO del monitor vigente y declarado (hecho 2, D7); el log del server registra el fallo del sink; endurecerlo es scope creep consciente. |
| `<url|label>` no soportado por el webhook Slack de la instancia ([C1]) | Gate manual G-M1; si refuta, el fix es local a `renderSlackText` (un render, no la arquitectura). |
| Dominio tageado pero no declarado ⇒ enlace a ruta inexistente | Sellado: enlaces SOLO con dominio declarado (hecho 5, D5); el aviso dice por qué no trae enlace. |
| El contrato JSON del webhook genérico driftea cuando #102 lo reuse | El payload es el `Notification` mismo, sellado en D6 y observado por test T1 (deep-equal); #102 compone mensajes, no toca el contrato. |
| Textos del aviso divergen entre tests y producción | Composición PURA única (`notify.ts`) usada por el lazo y observada carácter a carácter en T1; el lazo no formatea nada por su cuenta. |

---

*Diseño: Fable 5 (rol diseñador, ww:wingcoding) · 2026-08-06 · Issue #100 · Toda afirmación de mecanismo está verificada contra el código citado o etiquetada [Conjetura]; el estado post-#105 se cita del diseño sellado `diseno-gh105.md`; el único gate que exige canal vivo está declarado como G-M1.*
