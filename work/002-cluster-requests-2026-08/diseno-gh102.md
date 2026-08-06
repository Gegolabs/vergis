# Diseño · Issue #102 — Reporte periódico de lo ejecutado, enviado SIEMPRE (con novedades o sin ellas)

**Rol:** documento de diseño ejecutable (contrato de delegación wingcoding). El ejecutor arranca en frío: todo lo que necesita está aquí o en las rutas exactas citadas. Repo: `/Users/cesar/wworkspace/productos/vergis` (monorepo TypeScript; `packages/capabilities` = librería; `server/` = módulos de `serve-rls`; `tests/` = vitest).

**Issue:** [Gegolabs/vergis#102] — reporte periódico —diario por defecto— con TODO lo ejecutado en el período, a destinatarios configurables: por proceso, si corrió, cuándo y con qué desenlace, y EXPLÍCITAMENTE lo que no corrió debiendo. Enlaces a la vista transversal (#101) y a los logs (#99). **Condición de diseño: se envía SIEMPRE, aunque no haya novedades** — un digest silencioso no es discreto, es ambiguo: un día sin correo debe leerse como señal de problema. No contradice el anti-ruido de #100: la alerta es por evento y se contiene; el reporte es periódico e incondicional (latido). Fuera de alcance del issue: que el producto administre su propio servidor de correo — emite el reporte; el canal de salida lo provee la instancia.

**PRECONDICIÓN DE BASE (orden de olas):** este diseño se implementa sobre `main` (HEAD ≥ `bf4ed31` — #99 y #105 YA mergeados y verificados contra código) **+ el diseño de #100 ejecutado** (`work/002-cluster-requests-2026-08/diseno-gh100.md`): debe existir `server/notify.ts` con `Notification`/`NotificationSink`/`parseNotifyConfig`/`createSinks`/`renderSlackText`/`fanout`/`fmtDur`, la config `VERGIS_NOTIFY` y el env `VERGIS_PUBLIC_URL`. Si al implementar `server/notify.ts` no existe, **DETENERSE**: este documento no es ejecutable sin ese puerto.

**Precedencia de fuentes:** (1) el código en HEAD; (2) el diseño sellado de #100 (sus contratos D1–D8 se asumen tal cual); (3) este documento. Si la implementación de #100 difiere en UBICACIÓN o detalle no-contractual (p. ej. dónde exactamente quedó el parse de `VERGIS_NOTIFY` en `serve-rls.ts`), se sigue el código implementado conservando los contratos sellados. Los diseños de #101 (`diseno-gh101.md`) y #99 (`diseno-gh99.md`) se citan solo para el FORMATO de los enlaces; sus territorios no se tocan.

---

## ¿Cuál es la realidad del código sobre la que se diseña?

Hechos verificados contra el código (2026-08-06, rama `main`, HEAD `bf4ed31`):

1. **El lazo de frescura de #105 existe y es el patrón de lazo del server.** `server/freshness-loop.ts` (`createFreshnessLoop`): guard anti-solape `inFlight`, `try/catch` global (el timer no muere), hidratación de estado en el primer tick, `now?: () => number` inyectable. Su wiring (`serve-rls.ts:1094-1119`): gated por `fabricWiring.engine && freshnessPollMs > 0`, `setInterval(...).unref?.()` + primer tick `setTimeout(..., 10_000).unref?.()`, log de arranque explícito. La costura de aviso HOY es `postAlert?: (text) => Promise<void>` (Slack inline) — **#100 la reemplaza por `notify?: (n: Notification)` con sinks declarativos** (su D8); este diseño asume ese estado.
2. **#100 NO está mergeado**: grep de `VERGIS_NOTIFY|parseNotifyConfig|notify.ts` sobre `server/` y `tests/` = cero hits. Sus contratos se citan de su diseño sellado, no del código.
3. **`freshnessInputs` ya devuelve las fuentes**: `serve-rls.ts:1071-1085` retorna `{ sources, procs, outputs, mapInput }` — todo lo que el reporte necesita del registro (procesos con label y `sourceId`, fuentes con `domain`) sale de UNA llamada existente, sin motor.
4. **La proyección de corridas es legible sin motor**: `listRunSnapshots(opts?: { runsPerProcess?: number })` (`governance-store.ts:269-292`, impl `:1214+`) devuelve por proceso `runs` (más reciente primero), `scheduleSeconds`, `observedAt` (null = proyección fría), `lastError`/`lastErrorAt`. Default 10 corridas por proceso; la retención es `INGESTION_RUN_RETENTION = 60` (`governance-store.ts:253`, exportada en `index.ts:100`) — **para una ventana diaria con procesos horarios, 10 no alcanza (24 corridas/día): el reporte pide 60**.
5. **`platform_setting` es el registro durable de estado operacional**: `PlatformSettingStore.getSetting/setSetting` (`governance-store.ts:157-159`, impl `:894-908`), ya usado por el lazo para `freshness.alert_state`. El GovernanceStore es sql.js con persist de archivo completo — **NO abrir un segundo handle sobre el mismo archivo** (dos copias en memoria se clobberean al persistir); todo consumidor usa el `govStore` del bloque de administración.
6. **`deriveIngestionMap` EXCLUYE los event-driven** (`freshness.ts:134-138`: `isEventDriven(oferta) → []`) y da `requiredCadenceSeconds` + `label` + `unsatisfiable` por proceso agendado (`freshness.ts:96-108`). Un proceso observable fuera del mapa = sin cadencia exigida.
7. **`classifyProcess(runs, req, nowMs)` es la ÚNICA clasificación de salud** (`ingestion-observability.ts:37-46`): `missed = ageSeconds == null || ageSeconds > requiredCadenceSeconds` — computa «no corrió debiendo» acumulado aunque la ausencia empiece antes de la ventana del reporte. `RunStatus = 'Completed' | 'Failed' | 'InProgress' | 'NotStarted' | 'Cancelled' | 'Deduped'` (`:15`); `RunRecord { startedAt, endedAt?, status, error? }` (`:17-23`).
8. **El bloque de gobierno gatea todo lo que el reporte necesita**: `if (process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length)` (`serve-rls.ts:793`) abre `govStore` DENTRO de un `try` no-fatal («administración deshabilitada»). La config declarativa se valida FATAL y FUERA de ese try (#117: `loadInstanceConfig`, `serve-rls.ts:786-790`, `server/instance-config.ts`) — **la config del reporte debe validar en esa zona fatal, no dentro del try** (un YAML roto degradando en silencio es el modo de falla que #117 existe para atrapar).
9. **Los dominios declarados viven en `domainsCfg: DomainDecl[]`** (`serve-rls.ts:414`, arreglo vivo module-level; `DomainDecl { id, label, stewards? }` — `domain.ts:16-28`). `ProcessRow { id, label, sourceId, engine?, logs? }` (`governance-store.ts:128-137`); `SourceRow { id, label, oferta, domain? }` (`:103-111`).
10. **Las superficies destino de los enlaces existen**: `/admin/sources` (vista transversal, `admin.ts:422`; #101 le agrega columnas sin mover la ruta) y `/admin/dominio/<id>/corrida?proc=<processId>&started=<ISO>` (#99, mergeado en `309232d`; `admin-corrida.ts` presente). El `startedAt` proyectado es la MISMA cadena del motor (#105 D2) — el enlace casa exacto.
11. **Cero dependencias de producción utilizables para email**: `package.json` deps = `ajv`, `ajv-formats`, `sql.js`, `yaml`. `engines.node >= 22` — `fetch` global (ya usado), `node:net`/`node:tls`/`node:crypto` builtin. El build es esbuild bundle con externals declarados (agregar una dep = tocar supply chain Y el build).
12. **El nodo resuelve timezones IANA con DST correcto**: verificado con el node 22 local (ICU 78) — `America/Santiago` da UTC−4 en agosto y UTC−3 en enero vía `Intl.DateTimeFormat({ timeZone })`. Los builds oficiales de Node embeben full-icu por defecto desde v13; los tests de este diseño ejercitan `America/Santiago` en CI — si un runtime viniera con small-icu, esos tests lo refutan (el experimento acompaña a la afirmación).
13. **El patrón de auditoría**: `auditLog.append(e)` (`AppendOnlyLog` file-only, `serve-rls.ts:1112` en el wiring del lazo).
14. **`fmtDur` y `renderSlackText` quedan sellados por #100 en `server/notify.ts`** (su sección de contratos) — este diseño los REUSA, no los duplica.

Conjeturas etiquetadas:

- **[Conjetura C1]** El relay SMTP de la instancia (p. ej. OCI Email Delivery en GH) habla SMTP submission estándar: EHLO + STARTTLS + AUTH PLAIN o LOGIN en puerto 587. No verificado contra relay vivo → gate manual G-M1. El cliente es genérico (RFC 5321/5322); si el relay exige otra cosa, es parámetro/extensión del sink, no rediseño.
- **[Conjetura C2]** `openssl` está disponible en la máquina del EJECUTOR para generar UNA VEZ la fixture de certificado de los tests TLS (verificado en esta máquina: `/opt/homebrew/bin/openssl` 3.6.3; el PEM queda COMMITEADO — el runtime de CI no necesita openssl). Si no estuviera: fallback declarado en T1.

---

## ¿Cuáles son las decisiones de diseño? (selladas, con racional)

**D1 — El reporte es un `Notification` compuesto por el producto y emitido por el puerto de #100; dos módulos nuevos: `server/report.ts` (aritmética de período + composición + lazo) y `server/smtp.ts` (cliente SMTP de submission).**
Racional: (a) el puerto ya es canal-agnóstico por diseño expreso de #100 («#102 compone sus propios `Notification` y los envía por los mismos sinks»); (b) `report.ts` reúne TODO lo del reporte (patrón `notify.ts`: puro + lazo en un módulo de server, testeable con clock/sinks fake); (c) `smtp.ts` va aparte porque es un protocolo completo con su propia suite — `notify.ts` solo lo cablea como un sink más. Ambos en `server/` (I/O; únicos consumidores son módulos de server — mismo racional que #100 D1).

**D2 — Declaración: TODO en el YAML de `VERGIS_NOTIFY`. Cada destino gana `events` (a qué flujos se suscribe; default `['alerts']`) y la config gana un bloque `report:` (hora, timezone, cadencia). Cero envs nuevas.**
Forma (validación exacta en contratos): `destinations[].events?: ('alerts'|'reports')[]` y `report: { at, timezone?, every, weekday? }`. Racional: (a) coherencia con #100 — un solo archivo declara los canales de salida de la instancia; (b) el routing por tipo de mensaje vive en la CONFIG y se aplica en el WIRING (`forEvent`), no en el mensaje: `Notification` queda intacto; (c) default `['alerts']` conserva EXACTA la semántica implementada por #100 (sus tests pasan sin editar) y hace imposible que un destino reciba el digest sin haberlo pedido. Validación cruzada fail-closed: `report:` sin ningún destino suscrito a `reports` LANZA; destino suscrito a `reports` sin bloque `report:` LANZA (una promesa sin emisor y un emisor sin receptor son ambos config contradictoria — boot roto con mensaje claro, patrón #117/hecho 8).

**D3 — El canal EMAIL es un sink `email-smtp`: cliente SMTP de SUBMISSION propio, minimal, sobre `node:net`/`node:tls`. CERO dependencias nuevas. Direct-to-MX explícitamente EXCLUIDO.**
Racional supply-chain, evaluadas las tres vías:

- **nodemailer (o similar)** — descartado: árbol de dependencias transitivo y mantenimiento de terceros para usar el 5 % de su superficie (submission a un relay); viola la política de cero deps sin necesidad que lo justifique, y obliga a tocar los externals del build (hecho 11).
- **HTTP API de email (SES/SendGrid/Graph/…)** — descartado como contrato del producto: cada proveedor tiene su API, su auth y su forma de payload; el producto quedaría casado con un vendor o cargando un mini-framework de proveedores. Una instancia que prefiera esa vía YA la tiene: el sink `webhook` de #100 postea el `Notification` como JSON declarado y un puente de instancia lo reenvía — ese es exactamente el rol del webhook genérico.
- **Solo webhook→bridge (declarar el email como fase futura)** — descartado: el issue pide email y un bridge es un COMPONENTE DESPLEGADO más por instancia… que a su vez hablaría SMTP con el relay. Sería mover las mismas ~250 líneas fuera del repo, donde nadie las testea.

SMTP es el protocolo neutral que todo relay habla (incluido el de la instancia GH — [C1]). El alcance del cliente queda sellado y ACOTADO: submission a UN relay configurado (EHLO → STARTTLS opcional → AUTH PLAIN|LOGIN opcional → MAIL/RCPT/DATA → QUIT), mensaje `text/plain; charset=utf-8` en base64, subject RFC 2047. **Lo que el producto NO hace** (el «servidor de correo» que el issue deja fuera): resolución MX, colas y reintentos de entrega, DKIM/SPF, manejo de rebotes. Eso es del relay de la instancia. El cliente es honesto consigo mismo (Norma 7, corolario de instrumentos): timeouts con nombre de fase, códigos inesperados con la línea del server, y JAMÁS confunde «no pude conectar» con «enviado»; se testea contra un servidor SMTP fake in-process (vitest levanta `net`/`tls` servers — el protocolo entero queda bajo CI, incluida la negociación TLS con cert fixture).

**D4 — El scheduler es un lazo PROPIO (`createReportLoop`), separado del lazo de frescura, con chequeo cada 60 s.**
Racional: el lazo de frescura está gated por `fabricWiring.engine && poll > 0` (hecho 1) — colgar el latido de ahí lo silenciaría exactamente cuando más informa (motor sin cablear, poll apagado). El reporte se gatea SOLO por `report:` declarado. Vive en el bloque de gobierno (necesita `govStore` — hecho 5/8) con el patrón de timers del server (interval `unref` + primer tick `setTimeout(15_000)`); el chequeo de 60 s es constante interna (`REPORT_CHECK_MS`), no env: no hay caso de instancia para tunearlo, y la precisión del envío queda en ±1 min.

**D5 — Timezone y hora: `report.timezone` (IANA, validada al parse); default = timezone del HOST resuelta en el boot (`Intl.DateTimeFormat().resolvedOptions().timeZone`) y LOGUEADA en la línea de arranque. La aritmética de calendario es pura, con `Intl`, sin deps.**
La ocurrencia due se computa con `lastDueAt(nowMs)` (contratos): doble pasada de offset para bordes DST; hora local inexistente (salto de DST) ⇒ el due se corre al instante en que el reloj local la alcanza; hora repetida (fin de DST) ⇒ ambigüedad de una hora resuelta determinísticamente por el offset — el invariante REAL (un envío por período) no depende de esa resolución porque la idempotencia es por `periodKey` (D9), y ESO es lo que los tests encodan.

**D6 — Se envía SIEMPRE: la composición no tiene camino que calle.**
(a) Día sin novedades ⇒ reporte con `⟨n⟩ corrieron · 0 con fallo · 0 no corrieron debiendo` (severity `info`). (b) Cero procesos declarados ⇒ reporte que lo dice. (c) Falla la lectura de proyección o registro ⇒ `composeReportUnavailable`: reporte de indisponibilidad (severity `warning`, «se emite igual como latido») — el instrumento reporta su propio fallo en vez de callar. (d) Fallan TODOS los destinos ⇒ reintento cada 10 min hasta que el período ruede (D10). El ÚNICO silencio posible es el proceso caído — que es exactamente la señal que el issue diseña.

**D7 — Contenido sellado: título de forma FIJA y escaneable, secciones accionables primero, horas en la timezone del reporte, staleness de la proyección DECLARADA.**
Título: `Reporte de ingestión — ⟨período legible⟩ — ⟨c⟩ corrieron · ⟨f⟩ con fallo · ⟨a⟩ no corrieron debiendo` (siempre los tres números: un latido se lee de un vistazo y su forma no cambia con el contenido). Secciones en orden: Con fallo → No corrieron debiendo → Corrieron bien → dentro-de-cadencia sin corrida → proyección fría → sin cadencia exigida → no observables (cadenas exactas en contratos). Los instantes se muestran `YYYY-MM-DD HH:MM` en la timezone del reporte — a diferencia de las alertas de #100 (ISO UTC, canal desconocido), el reporte CONOCE a su audiencia: declaró su timezone. La frescura de la propia proyección va EN el reporte (líneas selladas: observación apagada / última observación vieja / motor no cableado) — un reporte con datos rancios que no lo dice es un dato falso. Severity: `warning` si `f+a > 0` o hay línea `⚠`; si no `info`.

**D8 — Enlaces: la vista transversal SIEMPRE; el log de cada fallo cuando es enlazable.**
`links = [{ label: 'Fuentes e ingestas', url: ⟨base⟩/admin/sources }]` (#101 vive ahí — hecho 10) + por cada proceso Con fallo cuya fuente tenga dominio DECLARADO (mismo criterio que #100 D5: tageado Y en `domains.yaml`) y con corrida: `{ label: 'Log — ⟨processLabel⟩', url: ⟨base⟩/admin/dominio/⟨dom⟩/corrida?proc=…&started=… }` con `encodeURIComponent` en los query values (#99 D5; el `started` casa exacto — hecho 10). Sin dominio declarado ⇒ sin link de log para ese fallo (no se ofrece un enlace que nace muerto).

**D9 — Idempotencia: registro durable del último envío en `platform_setting`, clave `report.last_sent`; se persiste SOLO tras al menos UN destino exitoso (at-least-once).**
JSON `{ periodKey, dueAt, sentAt, delivered, failed }`, parse fail-safe (basura ⇒ null ⇒ se trata como «nunca enviado» ⇒ envía el período vigente: el peor caso es UN duplicado, jamás un silencio). Racional del orden persistir-DESPUÉS-de-enviar (inverso al de las alertas #104/#100): allá un re-aviso entrena a ignorar la alerta; acá un latido duplicado es inocuo y un latido perdido es una falsa alarma de sistema caído — cada semántica con su orden, y ambos declarados. El envío del reporte NO usa `fanout` (que aísla y traga): despacha sink por sink capturando el resultado de cada uno — necesita saber si entregó para decidir si persiste.

**D10 — Catch-up: en CUALQUIER tick (incluido el primero tras un arranque), si el due del período vigente pasó y no está registrado como enviado ⇒ se envía YA. La ventana se EXTIENDE hacia atrás hasta el último envío registrado (cap 7 períodos), y el reporte declara el hueco.**
Racional con la condición del issue: si la instancia estaba caída a las 07:30 y vuelve a las 10:00, el latido de hoy se recupera a las 10:00 — la ausencia definitiva queda reservada para «sigue caída». No se re-emiten los reportes perdidos uno a uno (N correos rancios en ráfaga = ruido): UN reporte cuya ventana cubre lo no reportado y cuya línea sellada dice cuántos envíos se perdieron — el hueco mismo es información y queda nombrado. Retry ante fallo de TODOS los destinos: cada `REPORT_RETRY_MS` (10 min, constante) mientras el período siga vigente; en memoria (no persiste intentos fallidos).

**D11 — El reporte lee SOLO la proyección (#105) y el registro local: `listRunSnapshots({ runsPerProcess: INGESTION_RUN_RETENTION })` + `freshnessInputs()`. El motor, JAMÁS.**
Racional: es la regla de #105 (el request path y ahora el report path no tocan el motor) y la razón de pedir 60 corridas (hecho 4). La salud «no corrió debiendo» acumulada se computa con `classifyProcess` sobre las corridas proyectadas COMPLETAS al instante due (no solo las de la ventana): la última exitosa puede ser anterior a la ventana (hecho 7).

**D12 — El wiring de alertas de #100 gana UN filtro: los sinks del lazo de frescura se crean con `forEvent(cfg, 'alerts')`; los del reporte con `forEvent(cfg, 'reports')`. AMBAS listas de sinks se crean en la zona de config FATAL (top-level), no dentro del try del bloque de gobierno.**
Racional del traslado: `createSinks` de un destino email resuelve `passEnv` y `caFile` — si faltan debe TUMBAR el boot con nombre y ruta (patrón #117, hecho 8), no morir como «administración deshabilitada». Es un delta de ubicación de dos `const` sobre el wiring de #100, declarado aquí; el contrato de `createSinks` no cambia (gana un tercer parámetro opcional, D13). Con `events` ausente en todos los destinos, la conducta es BIT A BIT la de #100 (default `['alerts']`).

**D13 — Inyección para tests: `createSinks(cfg, fetchImpl?, sendMail?)` — el tercer parámetro (default `sendSmtp` real) permite testear el sink email sin sockets; `sendSmtp` a su vez se testea contra servidores fake in-process.**
El render email es composición pura exportada (`renderEmailSubject`/`renderEmailText`) — misma disciplina que `renderSlackText` de #100: una sola fuente de textos, observada carácter a carácter.

**D14 — Fuera de alcance declarado (sin scope creep):** email HTML o adjuntos (el `Notification` es texto estructurado; HTML es render futuro de canal); replay individual de reportes perdidos (D10 los cubre con ventana extendida); AUTH XOAUTH2/CRAM-MD5 (PLAIN/LOGIN cubren los relays estándar — [C1]); direct-to-MX, DKIM, bounces, colas (D3); UI de administración para configurar el reporte (es config declarativa de instancia); cadencias distintas de `daily`/`weekly` y múltiples schedules simultáneos; tocar el contenido/canales de las ALERTAS (#100) más allá del filtro de D12.

**Cero preguntas abiertas.** Ambigüedad no prevista ⇒ resolver con el principio: el latido primero (enviar algo verdadero antes que callar), fail-visible en el boot para config y en el cuerpo del reporte para datos, y sin tocar las reglas duras.

---

## ¿Qué contratos y tipos exactos se introducen?

### `server/smtp.ts` (NUEVO — cliente SMTP de submission, cero deps)

```ts
/**
 * Cliente SMTP de SUBMISSION (issue #102) — envía un mensaje a UN relay configurado por la
 * instancia. Minimal y honesto: EHLO → [STARTTLS] → [AUTH PLAIN|LOGIN] → MAIL/RCPT/DATA → QUIT,
 * texto plano UTF-8 en base64, subject RFC 2047. Cero dependencias (node:net / node:tls).
 *
 * Lo que NO es (fuera de alcance del issue: el canal lo provee la instancia): no resuelve MX, no
 * encola ni reintenta la entrega, no firma DKIM, no procesa rebotes. Un relay caído es un error
 * REPORTADO (SmtpError con fase y código), jamás un éxito silencioso ni un cuelgue sin nombre.
 */
export interface SmtpAuth { user: string; pass: string; method?: 'plain' | 'login' } // default 'plain'
export interface SmtpConnectConfig {
  host: string
  port: number
  /** starttls (587, upgrade tras EHLO) | implicit (465, TLS desde el byte cero) | none (relay local). */
  tls: 'starttls' | 'implicit' | 'none'
  /** CA(s) PEM adicionales (relay con CA privada). Ausente = store del sistema. */
  ca?: string[]
  auth?: SmtpAuth
  /** Timeout por respuesta del servidor (default 15_000) y de la sesión completa (default 60_000). */
  commandTimeoutMs?: number
  sessionTimeoutMs?: number
}
export interface MailMessage { from: string; to: string[]; subject: string; text: string }

export class SmtpError extends Error {
  constructor(message: string, public phase: string, public code?: number)
}

/** Envía UN mensaje. Resuelve solo tras el 250 final del DATA; cualquier otra cosa lanza SmtpError. */
export async function sendSmtp(cfg: SmtpConnectConfig, mail: MailMessage, nowMs?: number): Promise<void>

// ── exportadas para tests ──
/** MIME sellado (CRLF): From/To/Subject(RFC2047)/Date(RFC5322)/Message-ID/MIME-Version/
 *  Content-Type text/plain charset=utf-8/Content-Transfer-Encoding base64 + cuerpo base64 en 76 cols. */
export function buildMime(mail: MailMessage, nowMs: number): string
/** `=?utf-8?B?…?=` si contiene algo fuera de ASCII imprimible; tal cual si no. */
export function encodeHeaderWord(s: string): string
/** Dot-stuffing RFC 5321: línea que empieza con '.' → '..'. */
export function dotStuff(text: string): string
/** angle-addr para el envelope: `Nombre <a@b>` → `a@b`; sin ángulos → tal cual (trim). */
export function envelopeAddr(s: string): string
```

Diálogo sellado de `sendSmtp` (los tests lo observan contra un server fake):

1. Conectar: `tls: 'implicit'` ⇒ `tls.connect({ host, port, servername: host, ca? })`; si no ⇒ `net.connect`. Esperar `220`.
2. `EHLO vergis` ⇒ `250` (parser de multilínea: acumular hasta la línea `250␣` final; ídem para toda respuesta).
3. `tls: 'starttls'` ⇒ `STARTTLS` ⇒ `220` ⇒ upgrade `tls.connect({ socket, servername: host, ca? })` ⇒ `EHLO vergis` de nuevo.
4. `auth` presente ⇒ `plain`: `AUTH PLAIN ⟨base64("\0user\0pass")⟩` ⇒ `235`; `login`: `AUTH LOGIN` ⇒ `334` ⇒ `base64(user)` ⇒ `334` ⇒ `base64(pass)` ⇒ `235`. **El error de esta fase NUNCA incluye user ni pass** (solo código y `phase: 'auth'`).
5. `MAIL FROM:<⟨envelopeAddr(from)⟩>` ⇒ `250`; por cada destinatario `RCPT TO:<⟨envelopeAddr(to[i])⟩>` ⇒ `250` o `251`; `DATA` ⇒ `354`; `dotStuff(buildMime(...))` + `\r\n.\r\n` ⇒ `250`; `QUIT` (best-effort, sin esperar).
6. Código inesperado en cualquier fase ⇒ `SmtpError('smtp[⟨fase⟩]: respuesta ⟨code⟩ — ⟨línea del server⟩', fase, code)`. Timeout de comando ⇒ `SmtpError('smtp[⟨fase⟩]: timeout esperando respuesta', fase)`. Socket cerrado a mitad ⇒ error, jamás éxito. `rejectUnauthorized` queda en su default (true) — no existe knob inseguro.
7. Regla de parse en `parseNotifyConfig` (abajo): `auth` con `tls: 'none'` LANZA (credenciales en claro por la red).

### `server/notify.ts` (TOCAR — deltas sobre lo que crea #100; sus contratos D1–D8 intactos)

```ts
// ── Tipos: NotifyDestination pasa de interface a UNIÓN DISCRIMINADA (el email no tiene url) ──
export type NotifyEvent = 'alerts' | 'reports'
export interface WebhookDestination {
  id: string; type: 'slack-webhook' | 'webhook'; url: string
  /** A qué flujos se suscribe el destino. Default ['alerts'] (la semántica de #100, intacta). */
  events: NotifyEvent[]
}
export interface EmailSmtpDecl {
  host: string; port: number
  tls?: 'starttls' | 'implicit' | 'none'   // default 'starttls'
  caFile?: string                          // ruta a PEM (CA privada del relay)
  user?: string
  passEnv?: string                         // nombre de la env con la contraseña (requerido si user)
  authMethod?: 'plain' | 'login'           // default 'plain'
}
export interface EmailDestination {
  id: string; type: 'email-smtp'; events: NotifyEvent[]
  smtp: EmailSmtpDecl
  /** Remitente (configurable por instancia — pedido del issue). Acepta `Nombre <a@b>`. */
  from: string
  /** Destinatarios (lista configurable por instancia). */
  to: string[]
}
export type NotifyDestination = WebhookDestination | EmailDestination

export type ReportWeekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
export interface ReportSchedule {
  /** Hora local del envío, HH:MM. Default '07:00'. */
  at: string
  /** IANA. Ausente = timezone del host, resuelta en el boot y logueada. */
  timezone?: string
  every: 'daily' | 'weekly'                // default 'daily'
  /** Solo con weekly (default 'monday'); presente con daily LANZA. */
  weekday?: ReportWeekday
}
export interface NotifyConfig { destinations: NotifyDestination[]; report?: ReportSchedule }
```

`parseNotifyConfig(doc)` — reglas ADICIONALES (todas las de #100 se conservan; sus tests pasan sin editar):

- `events`: opcional; si viene, lista NO vacía con valores ∈ {`alerts`,`reports`} (otro valor o vacía ⇒ `Error: notify: destino #i con events inválido '…'`); ausente ⇒ `['alerts']`.
- `type: 'email-smtp'`: `smtp.host` string no vacío; `smtp.port` entero 1–65535; `tls` ∈ set (default `starttls`); `user` presente ⇒ `passEnv` requerido; `auth` con `tls: 'none'` ⇒ `Error: notify: destino '⟨id⟩' declara auth sobre tls 'none' (credenciales en claro)`; `from` string no vacío; `to` lista no vacía de strings que contienen `@`. El id default sigue el patrón de #100: `email-smtp-⟨i+1⟩`.
- `report`: `at` con regex `^\d{2}:\d{2}$` y HH<24, MM<60 (default `'07:00'`); `every` ∈ {`daily`,`weekly`} (default `daily`); `weekday` ∈ los siete valores — con `every: 'daily'` LANZA (`notify: report.weekday solo aplica a weekly`); default `'monday'` con weekly; `timezone` si viene se valida con `new Intl.DateTimeFormat('en-US', { timeZone })` en try ⇒ inválida LANZA nombrándola.
- Cruzadas (D2): `report` presente sin destino con `'reports'` ⇒ `Error: notify: report declarado pero ningún destino se suscribe a 'reports'`; algún destino con `'reports'` sin bloque `report` ⇒ `Error: notify: el destino '⟨id⟩' se suscribe a 'reports' pero no hay bloque report`.

```ts
/** Config filtrada a los destinos suscritos al flujo (el bloque report se conserva). PURA. */
export function forEvent(cfg: NotifyConfig, ev: NotifyEvent): NotifyConfig

export type SmtpSendLike = (cfg: SmtpConnectConfig, mail: MailMessage) => Promise<void>
/** Tercer parámetro NUEVO, opcional (default: sendSmtp real de './smtp'). */
export function createSinks(cfg: NotifyConfig, fetchImpl?: FetchLike, sendMail?: SmtpSendLike): NotificationSink[]
// email-smtp: EN CREACIÓN (boot) resuelve passEnv (process.env; ausente o vacía ⇒
//   Error `notify: destino '⟨id⟩': la variable ⟨passEnv⟩ no está definida`) y caFile
//   (readFileSync; fallo ⇒ Error con la ruta). send(n) = sendMail(smtpCfg, {
//   from, to, subject: renderEmailSubject(n), text: renderEmailText(n) }).
//   Como los demás sinks, NO captura errores (el despachante decide).

/** '⚠ ' + title si severity 'warning'; title tal cual si no. */
export function renderEmailSubject(n: Notification): string
/** `⟨title⟩\n\n⟨lines unidas por \n⟩` + (si hay links) `\n\n` + `⟨label⟩: ⟨url⟩` por línea + `\n`. */
export function renderEmailText(n: Notification): string
```

### `server/report.ts` (NUEVO — aritmética de período + composición + lazo)

```ts
/**
 * Reporte periódico de lo ejecutado (issue #102) — el LATIDO de la instancia.
 *
 * Se envía SIEMPRE a la hora configurada: con novedades, sin novedades, y aun cuando los insumos
 * fallen (reporte de indisponibilidad). Un digest que solo llega cuando hay algo que contar tiene
 * el mismo punto ciego que intenta cerrar: un día sin correo se leería igual que un día tranquilo.
 * Enviándolo incondicionalmente, la AUSENCIA del correo pasa a ser la señal (sistema caído).
 *
 * Lee SOLO la proyección local (#105) y el registro de gobierno; el motor, jamás. Idempotencia por
 * período (platform_setting `report.last_sent`, persistido tras ≥1 destino exitoso: at-least-once —
 * un latido duplicado es inocuo, un latido perdido es una falsa alarma). Catch-up: si el proceso
 * estaba caído a la hora del envío, el primer tick posterior envía YA, con la ventana extendida
 * hasta el último envío registrado (cap 7 períodos) y el hueco declarado en el cuerpo.
 */
import type { Notification, NotificationSink, ReportSchedule } from './notify'
import type {
  IngestionRunSnapshot, IngestionRunStore, PlatformSettingStore, ProcessRow, SourceRow,
  RunRecord, RunStatus, DeriveMapInput,
} from '@vergis/capabilities'

export const REPORT_LAST_SENT_KEY = 'report.last_sent'
export const REPORT_CHECK_MS = 60_000
export const REPORT_RETRY_MS = 600_000
export const REPORT_MAX_CATCHUP_PERIODS = 7

export interface ReportLastSent { periodKey: string; dueAt: string; sentAt: string; delivered: string[]; failed: string[] }
/** Fail-safe: basura o null ⇒ null (se trata como «nunca enviado»). */
export function parseReportLastSent(raw: string | null): ReportLastSent | null

// ── Aritmética de calendario (PURA, Intl; sin deps) ──
/** Partes wall-clock del instante en la tz (formatToParts, hour12:false). */
export function wallclock(tMs: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; weekday: number /* 0=domingo */ }
/** Offset del tz en el instante: Date.UTC(wallclock(t)) − t. */
export function offsetAtMs(tMs: number, tz: string): number
/** Instante del `at` (HH:MM) del día civil (y,m,d) en tz. Doble pasada de offset (borde DST);
 *  hora inexistente ⇒ el instante en que el reloj local la alcanza o pasa. */
export function dueFor(y: number, m: number, d: number, at: string, tz: string): number
/** Última ocurrencia programada ≤ nowMs (daily: hoy o ayer; weekly: el weekday de esta semana o la anterior). */
export function lastDueAt(nowMs: number, sched: Pick<ReportSchedule, 'at' | 'every' | 'weekday'>, tz: string): number
/** Ocurrencia anterior a un due: lastDueAt(dueMs − 1). El inicio de la ventana estándar. */
export function prevDueBefore(dueMs: number, sched: Pick<ReportSchedule, 'at' | 'every' | 'weekday'>, tz: string): number
/** YYYY-MM-DD del due en la tz — la identidad del período (idempotencia). */
export function periodKeyOf(dueMs: number, tz: string): string
/** `YYYY-MM-DD HH:MM` del instante en la tz (para humanos del reporte). */
export function fmtLocal(iso: string | number, tz: string): string

// ── Composición (PURA) ──
export interface ReportProcessRow {
  processId: string
  label: string
  /** Dominio ENLAZABLE: solo si la fuente lo tagea Y está declarado (regla #100 D5). */
  domainId?: string
  domainLabel?: string
  observable: boolean                 // engine_ref presente
  requiredCadenceSeconds?: number     // undefined = sin cadencia exigida (event-driven / sin demanda)
  fria: boolean                       // observedAt null (jamás observado)
  /** Corridas cuyo startedAt cae en [winStart, due), más reciente primero. */
  runsInWindow: RunRecord[]
  /** classifyProcess(runs proyectadas COMPLETAS, req, dueMs) — solo si observable, no fría y req finito. */
  missed?: boolean
  lastSuccessAgeSeconds?: number | null
}
export interface ReportPeriod {
  periodKey: string
  fromIso: string; toIso: string
  timezone: string
  every: 'daily' | 'weekly'
  /** Períodos cubiertos (1 = normal; >1 = ventana extendida por catch-up). */
  periodos: number
  primero: boolean
}
export interface ReportProjectionMeta {
  engineCabled: boolean
  lazoApagado: boolean                // freshnessPollMs <= 0
  /** max(observedAt) sobre los snapshots; null = nada observado. */
  maxObservedAt: string | null
  /** engineCabled && poll>0 && hay observables && (maxObservedAt null || edad > 3×poll). */
  stale: boolean
}
export interface ComposeReportInput {
  periodo: ReportPeriod
  procesos: ReportProcessRow[]
  proyeccion: ReportProjectionMeta
  baseUrl: string
}

/** Arma las filas desde los insumos crudos (todo local). windowStartMs/dueMs en epoch. */
export function buildReportRows(args: {
  snapshots: IngestionRunSnapshot[]
  procs: ProcessRow[]
  sources: SourceRow[]
  domains: { id: string; label: string }[]
  map: { processId: string; requiredCadenceSeconds: number }[]
  winStartMs: number
  dueMs: number
}): ReportProcessRow[]

export function composeOperationsReport(input: ComposeReportInput): Notification
/** El latido cuando los insumos fallan: jamás callar. */
export function composeReportUnavailable(periodo: ReportPeriod, detalle: string, baseUrl: string): Notification

// ── Lazo ──
export interface ReportLoopDeps {
  store: PlatformSettingStore & IngestionRunStore
  /** El MISMO freshnessInputs del wiring (ya devuelve sources — hecho 3). */
  inputs: () => Promise<{ sources: SourceRow[]; procs: ProcessRow[]; mapInput: DeriveMapInput }>
  domains: { id: string; label: string }[]
  sinks: NotificationSink[]
  audit: (e: { type: string; [k: string]: unknown }) => void
  log: (line: string) => void
  now?: () => number
}
export interface ReportLoopConfig {
  schedule: ReportSchedule
  /** Ya resuelta (schedule.timezone ?? tz del host). */
  timezone: string
  baseUrl: string
  freshnessPollMs: number
  engineCabled: boolean
}
export function createReportLoop(deps: ReportLoopDeps, cfg: ReportLoopConfig): { tick(): Promise<void> }
```

Semántica EXACTA de la clasificación (`buildReportRows` + `composeOperationsReport`; los tests observan cadenas). Sea `win = [winStartMs, dueMs)`; por proceso del registro:

1. Sin `engine` ⇒ `observable: false` → sección **no observables**.
2. Observable con `observedAt: null` ⇒ `fria: true` → sección **proyección fría** (ni «corrió» ni «ausente»: no se afirma lo no observado).
3. Observable con datos: `runsInWindow` = corridas del snapshot con `Date.parse(startedAt) ∈ win`. `req = map.get(id)` (`undefined` = sin cadencia exigida). Si `req` finito: `health = classifyProcess(snapshot.runs, req, dueMs)` ⇒ `missed`, `lastSuccessAgeSeconds`.
4. **Conteos del título:** `c` = observables no-frías con `runsInWindow.length > 0`; `f` = subconjunto de `c` cuya corrida MÁS RECIENTE de la ventana es `Failed`; `a` = observables no-frías con `runsInWindow.length === 0` ∧ `req` finito ∧ (`req ≤ (dueMs−winStartMs)/1000` ∨ `missed`).
5. Secciones (cada una se OMITE si vacía; ítems en el orden del registro):
   - `Con fallo (⟨f⟩):` → `✗ ⟨domainLabel · ⟩⟨label⟩ — falló ⟨fmtLocal(startedAt última de la ventana)⟩ · ⟨k⟩ corrida(s) en el período⟨ — ⟨error recortado a 200⟩⟩`
   - `No corrieron debiendo (⟨a⟩):` → `⟨domainLabel · ⟩⟨label⟩ — cadencia requerida ⟨fmtDur(req)⟩ · última exitosa ⟨hace ⟨fmtDur(age)⟩ | nunca⟩`
   - `Corrieron bien (⟨c−f⟩):` → `✓ ⟨domainLabel · ⟩⟨label⟩ — ⟨k⟩ corrida(s) · última ⟨fmtLocal⟩ ⟨desenlace⟩`
   - `Dentro de su cadencia, sin corrida en el período: ⟨labels unidos por ', '⟩` (observables con `req` finito > ventana, sin `missed`, 0 corridas)
   - `Sin observación aún (proyección fría): ⟨labels⟩`
   - `Sin cadencia exigida, sin corrida en el período: ⟨labels⟩` (`req` undefined, 0 corridas; con corridas van en Corrieron)
   - `No observables (sin motor): ⟨labels⟩`
   - Cero procesos en el registro ⇒ única línea `sin procesos de ingestión declarados`.
6. `desenlace(status)`: `Completed→'completó' · Failed→'falló' · InProgress→'en curso' · NotStarted→'en cola' · Cancelled→'cancelada' · Deduped→'omitida (duplicada)'`.
7. Cabecera de `lines` (antes de las secciones, en este orden y solo las que apliquen):
   - `período: ⟨fmtLocal(fromIso)⟩ → ⟨fmtLocal(toIso)⟩ (⟨timezone⟩)`
   - `primer reporte de esta instancia` — si `primero`.
   - `ventana extendida: cubre ⟨periodos⟩ períodos (⟨periodos−1⟩ envío(s) perdido(s) — la instancia estuvo caída o el envío falló)` — si `periodos > 1`.
   - Frescura de la proyección (a lo sumo una): sin motor ⇒ `sin motor de ingestión cableado — no hay procesos observables`; lazo apagado ⇒ `⚠ la observación del motor está apagada — los datos pueden estar incompletos`; `stale` ⇒ `⚠ última observación del motor: ⟨fmtLocal(maxObservedAt) | 'nunca'⟩ — pueden faltar corridas recientes`.
8. `title`: `Reporte de ingestión — ⟨periodKey | 'semana del ' + periodKey⟩ — ⟨c⟩ corrieron · ⟨f⟩ con fallo · ⟨a⟩ no corrieron debiendo`. `severity`: `'warning'` si `f+a > 0` o alguna línea empieza con `⚠`; si no `'info'`.
9. `links` según D8. `data`: `{ event: 'reporte-operaciones', periodKey, window: { from, to, timezone }, counts: { corrieron: c, conFallo: f, ausentes: a, frios, sinCadencia, noObservables }, periodos, procesos: [{ processId, seccion, corridas: k, ultima: startedAt|null }] }`.

`composeReportUnavailable`: `severity 'warning'`; `title` = `Reporte de ingestión — ⟨período legible⟩ — sin datos (error interno)`; `lines` = [línea de período, `⚠ no se pudieron leer los insumos del reporte — se emite igual como latido`, `detalle: ⟨msg⟩`]; `links` = [Fuentes e ingestas]; `data` = `{ event: 'reporte-operaciones', periodKey, error: msg }`.

Algoritmo EXACTO de `tick()` (patrón `freshness-loop`; los tests lo observan):

1. Guard `inFlight` (re-entrada = no-op con log) + `try/catch` global con log (nunca lanza; el timer no muere) + `finally` que libera.
2. Primer tick: `lastSent = parseReportLastSent(await store.getSetting(REPORT_LAST_SENT_KEY))`; marcar hidratado.
3. `dueMs = lastDueAt(now(), schedule, tz)`; `periodKey = periodKeyOf(dueMs, tz)`.
4. `lastSent?.periodKey === periodKey` ⇒ return (ya enviado; el caso sano no loguea).
5. `lastAttemptMs != null && now() − lastAttemptMs < REPORT_RETRY_MS` ⇒ return (retry en espera).
6. Ventana: `winStartMs = prevDueBefore(dueMs)`; `periodos = 1`. Si `lastSent` con `dueAt` parseable y `< winStartMs`: retroceder `winStartMs` ocurrencia a ocurrencia (`prevDueBefore` iterado) hasta cubrir `lastSent.dueAt` o alcanzar `REPORT_MAX_CATCHUP_PERIODS`, contando `periodos`.
7. Componer: en `try` — `const { sources, procs, mapInput } = await deps.inputs()`; `map = deriveIngestionMap(mapInput)`; `snaps = await store.listRunSnapshots({ runsPerProcess: INGESTION_RUN_RETENTION })`; `rows = buildReportRows(...)`; `meta` (proyección) con `engineCabled`/`freshnessPollMs`/`max(observedAt)`; `n = composeOperationsReport(...)` — `catch (e)` ⇒ `n = composeReportUnavailable(periodo, msg(e), baseUrl)`.
8. Despachar (SIN `fanout` — D9): por cada sink en orden, `try { await sink.send(n); delivered.push(id) } catch { failed.push(id); log('reporte[⟨id⟩]: ⟨msg⟩') }`.
9. `delivered.length > 0` ⇒ `setSetting(REPORT_LAST_SENT_KEY, JSON.stringify({ periodKey, dueAt: ISO(dueMs), sentAt: ISO(now()), delivered, failed }), 'report-loop')`; actualizar `lastSent` en memoria; `lastAttemptMs = null`; `audit({ type: 'reporte-operaciones', by: 'report-loop', periodKey, delivered, failed })`; `log('reporte ⟨periodKey⟩ enviado a ⟨delivered.join(',')⟩⟨ · fallaron ⟨failed⟩⟩')`. Si no: `lastAttemptMs = now()`; `log('reporte ⟨periodKey⟩: todos los destinos fallaron — reintento en ⟨REPORT_RETRY_MS/60000⟩ min')`.

### `server/serve-rls.ts` (TOCAR — guard, filtro de alertas, wiring del lazo de reporte, cabecera)

1. **Zona de config FATAL** (donde #100 dejó el parse de `VERGIS_NOTIFY` + guard de `VERGIS_PUBLIC_URL`; top-level, fuera del try de gobierno — hecho 8):

```ts
// Sinks por flujo (issues #100/#102): la creación resuelve passEnv/caFile de los destinos email —
// config rota tumba el BOOT con nombre (patrón #117), no muere como «administración deshabilitada».
const alertSinks = createSinks(forEvent(notifyCfg, 'alerts'))
const reportSinks = createSinks(forEvent(notifyCfg, 'reports'))
// El reporte lee la proyección del store de gobierno: sin bloque de gobierno no hay qué reportar.
if (notifyCfg.report && !(process.env['VERGIS_MASTER_DATA'] || ADMIN_SEED.length))
  throw new Error('VERGIS_NOTIFY declara report: pero la instancia no tiene bloque de gobierno (VERGIS_MASTER_DATA o VERGIS_ADMIN_SEED).')
```

(Si el orden de declaración lo exige, el guard se coloca inmediatamente después de que `ADMIN_SEED` y `notifyCfg` existan ambos — sigue top-level y fuera del try. El wiring del lazo de frescura de #100 pasa a usar `alertSinks` donde creaba sus sinks.)

2. **Bloque del lazo de reporte** — dentro del try de gobierno, DESPUÉS del bloque del lazo de frescura (necesita `govStore`, `freshnessInputs`, `domainsCfg`, `auditLog`, `freshnessPollMs`, `fabricWiring`):

```ts
// Reporte periódico de lo ejecutado (issue #102): latido incondicional — se envía SIEMPRE a la
// hora configurada, con novedades o sin ellas. Un día sin correo = señal de problema, por diseño.
// Independiente del lazo de frescura y del motor: se gatea SOLO por `report:` declarado.
if (notifyCfg.report) {
  const tzReporte = notifyCfg.report.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const reportLoop = createReportLoop(
    { store: govStore, inputs: freshnessInputs, domains: domainsCfg.map((d) => ({ id: d.id, label: d.label })),
      sinks: reportSinks, audit: (e) => auditLog.append(e), log: (l) => console.log(`[vergis-rls] ${l}`) },
    { schedule: notifyCfg.report, timezone: tzReporte, baseUrl: PUBLIC_URL,
      freshnessPollMs, engineCabled: !!fabricWiring.engine },
  )
  setInterval(() => void reportLoop.tick(), REPORT_CHECK_MS).unref?.()
  setTimeout(() => void reportLoop.tick(), 15_000).unref?.() // catch-up al arrancar (ventana perdida)
  console.log(`[vergis-rls] reporte periódico activo (${notifyCfg.report.every === 'weekly' ? `semanal ${notifyCfg.report.weekday ?? 'monday'}` : 'diario'} a las ${notifyCfg.report.at} ${tzReporte} · ${reportSinks.length} destino(s))`)
}
```

3. **Cabecera de env** (`serve-rls.ts:19-40`): en la línea de `VERGIS_NOTIFY` que documenta #100, agregar que el YAML admite destinos `email-smtp` (relay de la instancia), `events` por destino y el bloque `report:` (reporte periódico incondicional).

### `docs/frescura-oferta-demanda.md` (TOCAR — una fila)

Agregar a la tabla «Estado de implementación» una fila del reporte periódico: envío incondicional por período (`report:` en `VERGIS_NOTIFY`), catch-up con ventana extendida, idempotencia por `platform_setting`, destinos email-smtp/Slack/webhook con routing `events`. Sin rastros evolutivos.

---

## ¿Cómo se declara en la instancia? (referencia)

```yaml
# notify.yaml — VERGIS_NOTIFY=/ruta/notify.yaml (exige VERGIS_PUBLIC_URL; issue #100 + #102)
destinations:
  - id: ops-slack
    type: slack-webhook
    url: https://hooks.slack.com/services/T000/B000/xxxx
    events: [alerts, reports]        # también recibe el latido diario
  - id: correo-operaciones
    type: email-smtp
    events: [reports]                # solo el reporte (las alertas no van por email)
    smtp:
      host: smtp.email.us-sanjose-1.oci.example.com
      port: 587
      tls: starttls                  # starttls | implicit | none
      user: ocid1.user.oc1..xxxx@ocid1.tenancy.oc1..yyyy
      passEnv: VERGIS_SMTP_PASS      # la contraseña vive en el entorno, no en el YAML
    from: "Vergis GH <vergis@notificaciones.example.cl>"
    to: [operaciones@example.cl, cesar@example.cl]
report:
  at: "07:30"
  timezone: America/Santiago         # ausente = timezone del host (se loguea)
  every: daily                       # daily | weekly (weekly: weekday, default monday)
```

---

## ¿Qué tareas, con qué territorio y qué «hecho cuando»?

Orden: T1 → T2 → T3 → T4 → T5. T2 depende de T1 (tipos de smtp) y de #100 ejecutado (precondición). T3 depende de T2 (tipos de notify). Toda edición cae DENTRO del territorio de su tarea.

### T1 — Cliente SMTP (`smtp.ts`)

**Territorio:** crear `server/smtp.ts`, crear `tests/smtp.test.ts`, crear `tests/fixtures/smtp-cert.pem` + `tests/fixtures/smtp-key.pem` (fixture COMMITEADA, generada UNA vez por el ejecutor: `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout tests/fixtures/smtp-key.pem -out tests/fixtures/smtp-cert.pem -days 36500 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`). **Fallback si no hay openssl ([C2]):** cubrir el protocolo completo en modo `none` y declarar los modos TLS bajo G-M1 — dejándolo dicho en el reporte de la tarea, no en silencio.
**Hecho cuando:** `npx vitest run tests/smtp.test.ts` verde, con un servidor SMTP fake in-process (`node:net`/`node:tls`, guion programable por líneas) cubriendo como mínimo:

- Happy path `tls: 'none'` sin auth: secuencia EHLO→MAIL→RCPT→DATA→QUIT observada por el fake; el mensaje capturado trae los headers sellados de `buildMime`, el body base64 decodea al texto original (con acentos), y `Subject` con `⚠` llega como `=?utf-8?B?…?=` (roundtrip decodificado en el assert).
- AUTH PLAIN: el fake recibe `AUTH PLAIN ⟨b64⟩` correcto; AUTH LOGIN: la secuencia 334/334/235. Respuesta `535` ⇒ `SmtpError` con `phase: 'auth'` y `code: 535` cuyo `message` NO contiene ni el user ni la contraseña.
- Multilínea: EHLO respondido `250-PIPELINING\r\n250-STARTTLS\r\n250 OK` se parsea entero.
- `envelopeAddr('Vergis <v@x.cl>') === 'v@x.cl'`; `dotStuff('.peligro\nok') === '..peligro\nok'`.
- Dos destinatarios ⇒ dos RCPT TO.
- Servidor mudo tras EHLO ⇒ `SmtpError` de timeout que NOMBRA la fase (con `commandTimeoutMs` corto en el test); servidor que cierra el socket a mitad de DATA ⇒ error, JAMÁS resolución exitosa (el instrumento distingue «no pude» de «negativo» — Norma 7).
- `tls: 'implicit'` contra `tls.createServer` con la fixture + `ca: [cert]` ⇒ envío completo OK; `tls: 'starttls'` contra fake `net` que tras `STARTTLS`/`220` hace upgrade con `new tls.TLSSocket(socket, { isServer: true, ... })` ⇒ EHLO re-emitido tras el upgrade y envío OK.

### T2 — Deltas de `notify.ts` (routing + destino email + bloque report)

**Territorio:** tocar `server/notify.ts` (tipos unión, `events`, `email-smtp`, `ReportSchedule`, reglas de parse, `forEvent`, `createSinks` 3.er parámetro, `renderEmailSubject`/`renderEmailText`), tocar `tests/notify.test.ts` (**solo AGREGAR casos** — los asserts de #100 no se editan).
**Hecho cuando:** `npx vitest run tests/notify.test.ts` verde, cubriendo además de lo existente:

- `events` ausente ⇒ `['alerts']`; `events: []` o valor desconocido LANZA; `forEvent` filtra por flujo y conserva `report`.
- `email-smtp` válido parsea (defaults `tls: 'starttls'`, `authMethod: 'plain'`, id `email-smtp-1`); `port` inválido, `to` vacío/sin `@`, `from` vacío, `user` sin `passEnv` y `auth` con `tls: 'none'` LANZAN con sus mensajes.
- `report`: defaults (`at '07:00'`, `every 'daily'`); `at '25:00'` LANZA; `timezone 'America/Nowhere'` LANZA; `weekday` con `daily` LANZA; `report` sin destino `reports` LANZA; destino `reports` sin `report` LANZA.
- `createSinks` con `sendMail` fake: el destino email produce un sink cuyo `send(n)` invoca `sendMail` con la `SmtpConnectConfig` resuelta (pass leída de una env sembrada en el test) y `{ from, to, subject, text }` de los renders; env de `passEnv` ausente ⇒ `createSinks` LANZA nombrándola.
- `renderEmailSubject`: warning ⇒ prefijo `⚠ `; info ⇒ title tal cual. `renderEmailText`: cadena EXACTA con title, líneas y bloque de links `⟨label⟩: ⟨url⟩`.

### T3 — El reporte (`report.ts`): aritmética, composición y lazo

**Territorio:** crear `server/report.ts`, crear `tests/report.test.ts`.
**Hecho cuando:** `npx vitest run tests/report.test.ts` verde. Los tests usan `SqliteGovernanceStore.open(null)` real (para `platform_setting` + proyección sembrada vía `recordObservations`), sinks FAKE que capturan `Notification[]` (con modo «falla»), `now` inyectado; y cubren como mínimo:

1. **Aritmética con tz real** (los offsets concretos ya verificados: Santiago agosto = UTC−4, enero = UTC−3): `lastDueAt` para `at 07:30` daily en `America/Santiago` con `now` = 2026-08-06 12:00 UTC da 2026-08-06 11:30 UTC; con `now` anterior a la hora local da el día previo; weekly con `weekday` da el último lunes; `periodKeyOf` correcto en ambas estaciones; `prevDueBefore(due) + período = due` en días sin DST, y en la semana del cambio de hora el par (prevDue, due) difiere de 24 h SIN romper la unicidad del `periodKey`.
2. **Un envío por período (idempotencia):** primer tick tras el due ⇒ 1 `Notification`; diez ticks más del mismo período ⇒ 0 nuevos; el tick tras el due SIGUIENTE ⇒ 1 más con el `periodKey` nuevo.
3. **Se envía SIEMPRE (el experimento del issue):** proyección con corridas todas `Completed` ⇒ el reporte SALE igual, título `⟨n⟩ corrieron · 0 con fallo · 0 no corrieron debiendo`, severity `info`. Registro con CERO procesos ⇒ sale con `sin procesos de ingestión declarados`.
4. **Catch-up (Norma 7 — la corrida que refutaría el mecanismo):** `lastSent` sembrado en el store 3 períodos atrás + `now` pasada la hora ⇒ UN solo envío cuya ventana arranca en el due de hace 3 períodos, con la línea `ventana extendida: cubre 3 períodos (2 envío(s) perdido(s)…` y con una corrida de hace 2 días DENTRO de las contadas; `lastSent` 10 períodos atrás ⇒ ventana capada a `REPORT_MAX_CATCHUP_PERIODS`.
5. **Persistir solo con entrega (D9):** todos los sinks fallan ⇒ `report.last_sent` NO cambia; tick a +5 min ⇒ 0 intentos (retry en espera); tick a +11 min ⇒ reintenta; éxito ⇒ persiste; un lazo NUEVO sobre el MISMO store (reinicio simulado) ⇒ 0 reenvíos del período (hidratación). Un sink falla y otro entrega ⇒ SÍ persiste, con `failed` registrado y log `reporte[⟨id⟩]:`.
6. **Insumos caídos ⇒ latido de indisponibilidad:** `inputs()` que lanza ⇒ se envía `composeReportUnavailable` (warning, contiene `se emite igual como latido`) y se persiste como enviado.
7. **Clasificación y cadenas selladas** (composición pura, un caso por sección): fallo con error recortado y su ítem `✗ … falló …`; ausente con `cadencia requerida … · última exitosa hace …` y con `nunca`; corrió bien con `✓ … corrida(s) · última … completó`; cadencia 7 d con corrida hace 3 días (fuera de ventana, sin missed) ⇒ línea `Dentro de su cadencia…`; proyección fría ⇒ `Sin observación aún…`; sin cadencia y sin corridas ⇒ su línea; sin engine ⇒ `No observables (sin motor)`; conteos del título consistentes con las secciones; horas del cuerpo en formato `YYYY-MM-DD HH:MM` de la tz del período.
8. **Staleness declarada:** `engineCabled: false` ⇒ línea `sin motor de ingestión cableado…` (severity info si no hay fallos); `freshnessPollMs: 0` ⇒ `⚠ la observación del motor está apagada…`; `maxObservedAt` viejo (> 3×poll) ⇒ `⚠ última observación del motor…` y severity warning.
9. **Enlaces:** siempre `Fuentes e ingestas` → `⟨base⟩/admin/sources`; fallo con dominio declarado ⇒ link `Log — ⟨label⟩` con `proc=` y `started=` URL-encodeados (usar un `startedAt` con `:` para observar el encoding); fallo SIN dominio declarado ⇒ sin link de log.
10. **Robustez del lazo:** re-entrada con una vuelta en vuelo = no-op; `parseReportLastSent('basura') === null`; el tick jamás propaga (sink que lanza síncrono incluido).

### T4 — Wiring de producción y docs

**Territorio:** tocar `server/serve-rls.ts` (guard + `alertSinks`/`reportSinks` en zona fatal, uso de `alertSinks` en el wiring del lazo de frescura de #100, bloque del lazo de reporte, cabecera de env), tocar `docs/frescura-oferta-demanda.md` (una fila).
**Hecho cuando:** `npm run typecheck` y `npm run build` verdes; `npx vitest run tests/serve-rls.test.ts tests/acceptance.test.ts` verde (esos tests no definen `VERGIS_NOTIFY`: cero destinos, sin `report`, nada cambia — regresión cero).

### T5 — Juez completo

**Hecho cuando:** `npm run typecheck && npm test && npm run build` — los tres verdes, con `tests/smtp.test.ts` y `tests/report.test.ts` nuevos incluidos en `npm test`.

### G-M1 — Gate diferido/manual (instancia viva — NO es de CI; se declara, no bloquea el merge)

En la instancia GH (skill `mira-ops`; [C1]): (1) declarar el destino `email-smtp` contra el relay real de la instancia y verificar la llegada del reporte a un buzón real — subject con `⚠` bien decodificado, acentos correctos, enlaces clicables aterrizando en `/admin/sources` y en la página de corrida; (2) apagar la instancia sobre la hora del envío, re-arrancarla después y verificar el catch-up (correo enviado al arrancar con la línea de ventana extendida); (3) verificar el boot roto con `passEnv` sin definir (mensaje con el nombre de la variable en el log); (4) confirmar que las alertas NO llegan al destino email (routing `events`) y sí al Slack.

---

## ¿Qué NO se toca? (reglas duras)

- **`server/freshness-loop.ts` queda EXACTAMENTE como lo deje #100** (su D8): este diseño no le agrega fases ni deps — el reporte es OTRO lazo. Los tres invariantes de #104 y la proyección/`recordObservations`/`listRunSnapshots` de #105 (`governance-store.ts`) no se tocan: el reporte solo LEE (`listRunSnapshots`, `getSetting`) y escribe ÚNICAMENTE la clave `report.last_sent` vía `setSetting`.
- **No re-diseñar notify:** `Notification`, `NotificationSink`, `fanout`, `renderSlackText`, los sinks `slack-webhook`/`webhook` y su payload JSON quedan intactos. Los deltas son EXACTAMENTE los de la sección de contratos (unión de destinos, `events`, `email-smtp`, `report`, `forEvent`, 3.er parámetro de `createSinks`, renders de email). Los asserts existentes de `tests/notify.test.ts` y `tests/freshness-loop.test.ts` pasan SIN editar.
- **No tocar los territorios de #99/#101/#105**: `run-logs.ts`, `admin-corrida.ts`, `admin.ts`, `admin-cargas.ts`, `ingestion-observability.ts`, `freshness.ts`, `fabric-engine.ts`, `intake*.ts`, `governance-store.ts`, `instance-config.ts`, `packages/policy`, miranda*, notas*, master-data*, engines de serving. Los enlaces usan los formatos sellados de #99/#101 sin modificarlos.
- **Un solo handle del GovernanceStore** (hecho 5): el lazo de reporte usa el `govStore` del bloque de gobierno; JAMÁS abrir otro sobre el mismo archivo.
- **Los lazos jamás mantienen vivo el proceso** (`unref`) ni revientan el boot desde dentro del try; los errores de CONFIG (parse, passEnv, caFile, guard de gobierno) sí tumban el boot, y solo desde la zona fatal top-level.
- **Sin dependencias npm nuevas** (D3 es el compromiso: `node:net`/`node:tls`/`node:crypto` y nada más). Sin tocar los externals del build.
- Mensajes y UI en español; las cadenas selladas de D7/contratos se usan tal cual (los tests las observan). Los timestamps del cuerpo en la timezone del reporte; los de `data`/persistencia en ISO UTC.
- `sendSmtp` jamás loguea ni incluye credenciales en errores; la contraseña solo existe en `process.env[passEnv]` y en el socket.
- No modificar tests existentes salvo AGREGAR casos (T2); los asserts vigentes no se reescriben.

## ¿Quién juzga?

`npm run typecheck && npm test && npm run build` — los tres verdes, incluyendo `tests/smtp.test.ts` y `tests/report.test.ts` nuevos y los casos agregados a `tests/notify.test.ts`. El síntoma (el reporte sale SIEMPRE a su hora — con novedades, sin ellas, con insumos caídos y tras un downtime — con su contenido, sus enlaces y su idempotencia) lo observan los tests de T3 con clock/sinks fake y store real; el protocolo SMTP entero lo observa T1 contra servidores fake in-process. Su confirmación contra relay y buzón vivos es G-M1 (diferida, declarada).

## ¿Qué riesgos quedan y cómo los acota el diseño?

| Riesgo | Acotación |
|---|---|
| El cliente SMTP propio choca con un relay real quisquilloso ([C1]) | Alcance mínimo estándar (EHLO/STARTTLS/AUTH PLAIN+LOGIN), errores con fase+código+línea del server (diagnóstico directo), G-M1 contra el relay de la instancia; extensiones son parámetros del sink, no rediseño. |
| Runtime con small-icu rompe las timezones IANA (hecho 12) | Los tests ejercitan `America/Santiago` en ambas estaciones — CI lo refuta de inmediato; ICU full verificado en el node 22 de desarrollo. |
| Reporte duplicado (crash entre envío y persist) | At-least-once ELEGIDO y declarado (D9): para un latido, duplicar es inocuo y perder es una falsa alarma de sistema caído; la ventana del duplicado es milisegundos. |
| Todos los destinos caídos ⇒ latido perdido | Retry cada 10 min mientras el período viva (D10, test T3-c5); si aun así no sale, el correo ausente ES la señal diseñada, y el log del server registra cada intento. |
| Config contradictoria (report sin destinos, email sin pass, tz inválida) degradando en silencio | TODA la validación en zona fatal del boot (D2/D12, patrón #117): parse LANZA, `createSinks` LANZA, guard de gobierno LANZA — con nombres. |
| Ventana diaria con procesos horarios se queda corta de corridas | `runsPerProcess: INGESTION_RUN_RETENTION` (60) sellado (D11, hecho 4); si una instancia corre >60/período, el conteo se trunca por retención de #105 — límite heredado y visible en la proyección, no un bug nuevo. |
| «No corrió debiendo» falso con proyección fría o motor recién cableado | Fría es sección PROPIA (ni corrió ni ausente — D7 punto 2); la staleness de la proyección va declarada en el cuerpo (D7/T3-c8). |
| DST: envío doble o saltado en el cambio de hora | La idempotencia es por `periodKey`, no por instante (D5/D9): a lo sumo el envío se corre ±1 h ese día; test T3-c1 cubre la semana del cambio. |
| El filtro `events` cambia la conducta de las alertas de #100 | Default `['alerts']` = bit a bit lo implementado; los tests de #100 pasan sin editar (regla dura); solo un destino que OPTA por `reports` cambia algo. |
| Secretos SMTP en el YAML de la instancia | No se admiten: la contraseña va por `passEnv` (env de la instancia), el parse lo exige y el cliente jamás la incluye en errores/logs. |

---

*Diseño: Fable 5 (rol diseñador, ww:wingcoding) · 2026-08-06 · Issue #102 · Base declarada: main HEAD `bf4ed31` (#99/#105 verificados en código) + #100 ejecutado según su diseño sellado. Toda afirmación de mecanismo está verificada contra el código citado o etiquetada [Conjetura]; el mecanismo del catch-up y el del «se envía siempre» quedan puestos en riesgo por T3-c3/c4/c6; los gates que exigen relay/buzón vivos están declarados como G-M1.*
