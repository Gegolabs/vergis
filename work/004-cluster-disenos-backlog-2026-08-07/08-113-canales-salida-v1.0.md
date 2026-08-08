# 08 · Diseño del frente #113 — Canales de salida: email y Slack como destinos de primera clase

**Cluster:** 004 · diseño detallado del backlog (2026-08-07) · **Horizonte:** largo plazo — arquitectura decidida + primer hito ejecutable
**Issues cruzados:** #113 (épica) · #100 (aviso de fallo, entregado) · #102 (reporte periódico, entregado) · #110 (webhook post-F1, frente 06) · #138·2 (config recargable, frente 03) · realtime (frente 07)

---

## 1 · Estado actual verificado

El issue #113 nombra este frente como «email y Slack como destinos de primera clase, no solo la pantalla», con #100 y #102 como primeros consumidores concretos (`gh issue view 113`, cuerpo; sin comentarios — verificado con `--json comments`: `[]`). Ambos consumidores **ya están construidos y entregados** en 0.14.0 (`package.json:4`). La medición honesta de este terreno es la base del diseño: qué ya es de primera clase, qué es plomería de un caso de uso, y qué es una **promesa sin implementación**.

### 1.1 · Lo que ya es de primera clase (el puerto de notificación)

- **Mensaje canal-agnóstico.** `Notification` (`server/notify.ts:23-32`): `severity`/`title`/`lines`/`links`/`data` — estructura, no markup; cada sink renderiza a su forma (`server/notify.ts:2-7`).
- **Tres tipos de destino** (`server/notify.ts:40`): `slack-webhook` (mrkdwn `{text}`, `renderSlackText` `server/notify.ts:276`), `webhook` genérico (el `Notification` JSON tal cual, `server/notify.ts:247`) y `email-smtp` (subject RFC 2047 + cuerpo texto plano, `renderEmailSubject`/`renderEmailText` `server/notify.ts:258-267`).
- **Config declarativa de instancia.** `VERGIS_NOTIFY` → YAML → `parseNotifyConfig` (`server/notify.ts:109`), cargada en la fase fail-closed de `loadInstanceConfig` (`server/instance-config.ts:84`); forma inválida **tumba el boot** con nombre (patrón #117). Validación cruzada emisor↔receptor de reportes (`server/notify.ts:130-134`). Destinos declarados exigen `VERGIS_PUBLIC_URL` (`server/instance-config.ts:89-91`).
- **Routing por flujo.** `events: alerts | reports` por destino (`server/notify.ts:46,53,72`); el `Notification` no sabe por dónde sale — el wiring filtra con `forEvent` (`server/notify.ts:202`; `server/serve-rls.ts:880-881`).
- **Credenciales gated en la instancia** — verificado: la contraseña SMTP vive en el **entorno**, jamás en el YAML (`passEnv`, `server/notify.ts:64-65,157`), resuelta en el boot (`server/notify.ts:234-239`); la URL del webhook Slack vive en el YAML de instancia que la instancia monta; `deploy/compose.reference.yml` no trae ninguna variable de notify (verificado por grep: cero coincidencias — el encendido es acto de instancia, como declara #100 «Fuera de alcance»).
- **Cliente SMTP propio** (`server/smtp.ts`): submission a relay de instancia, cero dependencias, STARTTLS/implicit/none, AUTH PLAIN/LOGIN, timeouts nombrados, fase en el error. Explícitamente **no** resuelve MX, no encola, no reintenta, no firma DKIM (`server/smtp.ts:6-8`).
- **Dos disciplinas de despacho ya selladas:** alertas por `fanout` con aislamiento por sink, at-most-once (`server/notify.ts:283-291`); reporte sink-por-sink porque necesita saber quién entregó, at-least-once con idempotencia por período (`server/report.ts:494-517`).

### 1.2 · Lo que ya existe como scheduler (el patrón de #102)

`server/report.ts` tiene la aritmética completa de entrega programada en timezone: `lastDueAt`/`prevDueBefore`/`dueFor` con doble pasada de offset y bisección para horas inexistentes por DST (`server/report.ts:118-155`), identidad de período (`periodKeyOf`, `server/report.ts:158`), idempotencia persistida en `platform_setting` (`REPORT_LAST_SENT_KEY`, `server/report.ts:30`), catch-up con cap de 7 períodos (`server/report.ts:33,456-461`), reintento a 10 min si fallaron todos los destinos (`server/report.ts:32,516-517`), tick barato cada 60 s (`server/serve-rls.ts:1237`). **Está escrito para UN reporte** — las funciones de calendario son puras y genéricas; el lazo (`createReportLoop`) está atado a la clave única `report.last_sent` y al insumo de frescura.

### 1.3 · Lo que es plomería de un caso de uso

- El puerto solo transporta **avisos operacionales**: los dos compositores existentes (`composeFreshnessAlert` `server/notify.ts:315`, `composeOperationsReport` `server/report.ts:280`) llevan metadatos de procesos y corridas — nunca dato de negocio bajo RLS. El email es **texto plano sin adjuntos** (`MailMessage` = `from/to/subject/text`, `server/smtp.ts:32-37`; MIME de una sola parte, `buildMime` `server/smtp.ts:230-245`).
- Los sinks se crean **una vez en el boot** (`server/serve-rls.ts:880-881`); cambiar destinos exige reinicio — cruza con el frente 03 (#138·2, config recargable).
- Los destinatarios de email son una **lista suelta de direcciones** en el YAML (`to`, `server/notify.ts:77`) sin relación con el directorio de identidad ni con los grupos de gobierno.

### 1.4 · La promesa sin implementación (la grieta Miranda ↔ serving)

- El DSL de Mira ya declara `delivery.channels: [{type, capability, params, schedule}]` (`packages/mira/src/dsl/validate.ts:78`). El schema JSON deja `delivery` como objeto libre (`schema/mira-spec.schema.json`: `"delivery": {"type": "object"}` — verificado leyendo el schema); la validación real es la de `validate.ts:397-408` (capability del canal debe estar catalogada) y el dispatch de `mira.ts`.
- El dispatch entrega al canal **el HTML de pantalla**: `params = {...ch.params, content: html, baseDir}` (`packages/mira/src/mira.ts:264-269`). No hay render por canal.
- `channels[].schedule` es declarable pero **INERTE** — no hay scheduler (`packages/mira/src/dsl/validate.ts:395-396`, nota explícita del código).
- El único canal real es `publicar-artefacto`: stub que escribe a archivo local (`packages/capabilities/src/publicar-artefacto.ts:5-8`).
- **La grieta:** `MIRANDA_VALIDATE_CAPS` anuncia `send-email` y `send-slack` como capabilities válidas de un draft (`server/serve-rls.ts:1467`) — pero **no existen en ninguna parte del repo** (grep completo: esa línea es la única aparición) y el catálogo de serving registra solo `[servingCap, renderHtmlPiece, renderCsvPiece, publicarArtefacto]` (`server/serve-rls.ts:515,1529`). Consecuencia mecánica: un spec que Miranda valida OK con un canal `send-email` es **rechazado al registrarse en serving** con `channel-capability-not-catalogued`, porque `Botler.register` valida contra `capabilityNames()` reales (`packages/botler/src/botler.ts:89`; `packages/mira/src/dsl/validate.ts:397-408`). *(Cadena verificada leyendo el código; no ejecutada — el experimento que la refutaría es el test del hito H0.)*

### 1.5 · Los renders existentes que este frente reusa

- **HTML pantalla** — `render-html-piece`, el documento servido.
- **CSV** — `render-csv-piece` (`packages/capabilities/src/render-csv-piece.ts`): tablas RAW RFC 4180, artefacto en memoria (`content`), reusado por el export de #61.
- **PDF server-side** — no es formato de delivery del spec: es el **mismo render en modo print** convertido por el sidecar (`packages/mira/src/mira.ts:221-224`; `runPi` con `print` `server/serve-rls.ts:523`; `createPdfClient` `server/pdf.ts:65-87`, HTML → bytes por `POST /convert`).

### 1.6 · El modelo de identidad y autorización que la pantalla ya tiene

- La pantalla renderiza **bajo la identidad del request**: `runPi` → `identityFor(headers)` → `runSpec({identity})` (`server/serve-rls.ts:497-527`); los claims viajan hasta las capabilities y la fuente filtra por ellos (`packages/cli/src/run.ts:50-55`).
- Identidad = cabeceras del gate + **directorio** (`VERGIS_IDENTITY_MAP`, `server/serve-rls.ts:438-444`): email → claims, **fail-closed** — email no mapeado ⇒ sin claim ⇒ default-deny (`server/identity.ts:47-55`).
- Autorización de artefacto **AND** RLS de filas: rol efectivo (visor ⊂ colaborador ⊂ dueño) sobre visibilidad + grants por usuario y grupo; ser dueño jamás eleva los datos por encima del grant propio (`packages/capabilities/src/pi-authz.ts:1-11`).
- El gobierno ya sabe de grupos con miembros por email (`GovernanceStore.listMembers/isMember`, `packages/capabilities/src/governance-store.ts:67-68`).

**Síntesis de la medición.** Primera clase hoy: el puerto de notificación, su config fail-closed, el gating de credenciales y la aritmética de scheduling. Plomería: el puerto solo sirve a dos flujos operacionales fijos, email sin adjuntos, destinatarios sueltos, sinks congelados al boot. Vacío: el render por canal de un PI, el scheduler de entregas de specs, y la resolución de identidad de un destinatario push. Falso: que `send-email`/`send-slack` existan.

---

## 2 · Decisiones selladas

### D1 — Un solo registro de CANALES de instancia; los flujos son suscripciones que lo referencian

**Decisión.** Se separa **canal** (transporte + credenciales + remitente: *cómo llegar*) de **suscripción** (*qué* sale, *a quién*, *cuándo*). La instancia declara sus canales UNA vez en un registro (`VERGIS_CHANNELS` → `channels.yaml`); los tres consumidores — alertas (#100), reportes (#102) y entregas de specs (`delivery`) — referencian canales **por id** y aportan su audiencia. Un spec jamás lleva credenciales ni hosts: lleva el id de un canal de su instancia.

```yaml
# channels.yaml (VERGIS_CHANNELS) — registro de instancia
channels:
  - id: ops-slack
    type: slack-webhook
    url: https://hooks.slack.com/services/…      # la audiencia va implícita en el webhook
  - id: correo-institucional
    type: email-smtp
    smtp: { host: smtp.cliente.cl, port: 587, tls: starttls, user: vergis, passEnv: VERGIS_SMTP_PASS }
    from: "Vergis <vergis@cliente.cl>"

subscriptions:
  alerts:
    - channel: ops-slack
  reports:
    - channel: correo-institucional
      to: [ops@cliente.cl, gerencia@cliente.cl]
```

**Racional.** `VERGIS_NOTIFY` hoy mezcla las dos cosas: un destino email lleva transporte Y audiencia Y flujo en el mismo registro (`server/notify.ts:69-78`). Funciona para dos flujos fijos; no escala a «N specs entregan por el canal X a audiencias distintas» sin duplicar credenciales por spec. El corte canal/suscripción es el que permite que `delivery.channels[].channel: correo-institucional` de un spec resuelva contra el mismo transporte que el reporte, con otra audiencia. La audiencia es del tipo de canal: en email es `to`/`to_group`; en un incoming webhook de Slack viene horneada en la URL.

**Criterio de excelencia:** este es el modelo correcto aunque obligue a migrar `VERGIS_NOTIFY`. Lo construido (parse, sinks, gating) se **reusa como implementación de los tipos de canal**, no como forma del registro. `[aprobada por César · 2026-08-08]`: `VERGIS_NOTIFY` se acepta un release como alias con aviso de deprecación (mapeo mecánico: cada `destination` ⇒ un canal + una suscripción por cada `event`), y muere en el siguiente. Alternativa descartada: mantener dos registros para siempre — dos fuentes de verdad de credenciales, y el bug del futuro es «actualicé el SMTP en uno y el otro siguió mandando por el viejo».

### D2 — Contrato del render por canal: el canal NO recibe el HTML de pantalla

**Decisión.** Se sella un segundo tipo de mensaje junto a `Notification`: la **`Delivery`** — la entrega de un PI por un canal push. Su contrato:

- **Cuerpo = resumen + enlace, jamás el documento.** El cuerpo del email/mensaje Slack lleva: título del PI, vista/página, corte de datos (watermark de frescura), período/contexto si la entrega es programada, y el **enlace profundo a la pantalla**. No se intenta replicar el PI en HTML-de-correo: los clientes de correo no ejecutan los scripts de los que depende la interactividad del render (tablas, filtros, drill — todo el runtime client-side del HTML servido), y un dialecto «HTML de email» del render sería un producto entero aparte. *(La incompatibilidad cliente-de-correo/JS es conocimiento general del dominio, no medido en este repo.)*
- **El documento viaja como ADJUNTO, con los renders que ya existen:** `pdf` = el mismo render en modo print pasado por el sidecar (`server/serve-rls.ts:523` + `server/pdf.ts:65`), `csv` = `render-csv-piece` en memoria (`packages/mira/src/mira.ts:229-239`). El spec declara `attach: [pdf, csv]`. No se inventa un render nuevo: la pieza de este frente es el **transporte multipart**, no otro renderer.
- **Slack v1 = cuerpo sin adjuntos** (un incoming webhook transporta texto; adjuntar archivos exige la API con token de bot — extensión declarada en §6, no v1).
- **El puerto de avisos queda intacto:** `Notification` sigue siendo la forma de alertas y reportes; `Delivery` es la forma del contenido de PI. Comparten transporte (canal), no forma.

**Racional.** El dispatch actual (`content: html` de pantalla, `packages/mira/src/mira.ts:265`) es exactamente lo que este frente corrige: ese HTML *es* una sesión de pantalla serializada. El par cuerpo-resumen + adjunto-fiel reusa los dos renders no-interactivos que la plataforma ya mantiene, con sus reglas ya selladas (print sin maquinaria #65·D4; CSV RAW #61).

### D3 — RLS en canales push: el destinatario es una identidad resuelta, o no hay envío

**La decisión de seguridad central del frente.** Un email llega a una persona, no a una sesión con claims. Se sella:

1. **Toda entrega de contenido de PI se renderiza BAJO LA IDENTIDAD DEL DESTINATARIO, destinatario por destinatario.** El mismo pipeline de la pantalla (`runSpec` con `identity`), con la identidad construida no desde cabeceras sino desde el email del destinatario, enriquecida por el mismo directorio (`enrichFromMap`, `server/identity.ts:47-55`). Dos destinatarios con claims distintos reciben **dos adjuntos distintos**. Renderizar una vez y repartir a todos queda prohibido por contrato: esa optimización *es* la fuga.
2. **Fail-closed donde no se pueda anclar.** Un destinatario cuyo email no está en el directorio (`VERGIS_IDENTITY_MAP`) no obtiene claims (`server/identity.ts:51`) — y para un PI con RLS eso significa default-deny: **no se le envía**, se registra en el log de auditoría, y el fallo sale como aviso por el flujo `alerts`. Jamás «se envía sin filtro», jamás «se envía el render de otro».
3. **La misma compuerta de la pantalla, dos candados AND:** el destinatario debe tener rol efectivo ≥ visor sobre el PI (visibilidad + grants, `packages/capabilities/src/pi-authz.ts`) **y** su RLS filtra las filas dentro. El canal no es una puerta lateral: si esa persona no podría abrir la URL, el email no se genera.
4. **Audiencia gobernada.** `to:` acepta emails directos; `to_group:` resuelve un grupo de gobierno a sus miembros **en el momento del envío** (`listMembers`, `packages/capabilities/src/governance-store.ts:67`) — la audiencia vive donde ya vive la membresía, no en una lista paralela que envejece.
5. **Por qué no es una fuga el aviso operacional existente:** alertas y reportes de #100/#102 no llevan dato de negocio (verificado en §1.3) — por eso su `to` suelto es aceptable y se conserva. La exigencia de identidad anclada aplica al **contenido de PI**, que es donde la RLS existe.
6. **El perímetro termina en la entrega.** Un PDF adjunto es re-enviable por el destinatario, igual que una impresión de la pantalla. El sistema garantiza que lo que *sale* fue filtrado para quien lo recibió; no pretende gobernar el reenvío — y el diseño lo declara para que nadie compre una promesa que ningún canal push puede cumplir.

**Racional.** La alternativa descartada — render único con la «identidad del spec» o del dueño — convierte cada entrega en una elevación de privilegio silenciosa (el dueño ve más que el visor; regla bedrock de `pi-authz.ts:3-5`: compartir config jamás comparte datos). El costo del render por destinatario es real (N renders por entrega) y se acota en §4 (cap de audiencia por entrega); es el precio de que el canal sea de primera clase *dentro* del modelo de seguridad y no un bypass.

### D4 — Scheduling: se generaliza el lazo de #102, no se inventa otro

**Decisión.** Las entregas programadas de specs reusan el patrón completo del reporte periódico: gramática de agenda idéntica (`at/every/weekday/timezone` = `ReportSchedule`, `server/notify.ts:83-91`), misma aritmética de calendario (funciones puras de `server/report.ts:118-169`, que se **extraen a un módulo compartido** `server/schedule.ts`), tick barato global (60 s), idempotencia por período con clave **por entrega** (`delivery.<specCode>.<subscriptionId>.last_sent` en `platform_setting`), at-least-once, catch-up con cap, reintento espaciado. `channels[].schedule` del DSL (hoy inerte) se reemplaza en el contrato nuevo por el bloque `schedule` de la entrega — y la nota de deprecación pendiente de `validate.ts:395-396` se ejecuta en ese mismo cambio de contrato coordinado.

**Racional.** El lazo de #102 ya resolvió los problemas difíciles (DST con bisección, catch-up acotado, «duplicado inocuo / perdido es falsa alarma», `server/report.ts:9-13`) y está probado en producción. Duplicarlo con otra semántica sería fabricar dos relojes que divergen. **Cruce declarado con el frente 07 (realtime):** el scheduler vive donde hoy vive el del reporte — `setInterval` en el proceso de serving (`server/serve-rls.ts:1237`); cuando exista el Botler persistente, los lazos migran juntos. El diseño no depende de esa migración; solo la anticipa (el lazo recibe sus deps inyectadas, como `createReportLoop` hoy — `server/report.ts:404-413`).

### D5 — Qué queda gated en la instancia

**Decisión.** Se conserva y extiende el gating verificado:

- **Credenciales**: contraseña SMTP por `passEnv` (nunca YAML — `server/notify.ts:157`); URL de webhook Slack en el YAML de instancia; futuro token de bot Slack por `tokenEnv` (mismo patrón). El repo/imagen jamás traen un canal encendido (`deploy/compose.reference.yml`: cero notify — verificado).
- **El registro de canales es de la instancia**; el spec solo referencia ids. Un spec que referencia un canal no declarado **no se registra** — error estructurado con remediation, el mismo patrón de `channel-capability-not-catalogued` pero contra el registro de canales.
- **Encender una entrega es acto de instancia + spec**: el canal existe en la instancia Y el spec lo referencia. Ninguno de los dos solo basta — simétrico al monitor de #100 («encender el monitor es acto de instancia»).

### D6 — Cerrar la grieta de Miranda: se anuncia lo que existe

**Decisión.** `MIRANDA_VALIDATE_CAPS` deja de anunciar `send-email`/`send-slack` (que no existen) **ya** — hito H0, ejecutable hoy. Cuando el registro de canales exista, Miranda valida los canales de un draft **contra los ids reales del registro de la instancia** (inyectados en `MirandaServerDeps`, como ya se inyecta `catalog` — `server/serve-rls.ts:1481`), no contra una lista escrita a mano. La lista a mano es exactamente cómo nació la grieta.

**Racional (Norma 6 aplicada al producto):** hoy Miranda puede validar OK un draft que serving rechaza (§1.4) — el validador miente con autoridad. Un validador que promete capacidades inexistentes es peor que uno estrecho: cierra la pregunta del autor con la respuesta equivocada.

---

## 3 · Arquitectura y contratos

### 3.1 · Cortes de módulo

```
server/channels.ts        (nuevo)  registro: parseChannelsConfig · tipos de canal · ChannelPort
server/schedule.ts        (nuevo)  aritmética de calendario extraída de report.ts (pura)
server/delivery-loop.ts   (nuevo)  lazo de entregas programadas de specs (patrón createReportLoop)
server/notify.ts          (queda)  Notification + compositores de avisos; sinks se crean DESDE el registro
server/smtp.ts            (crece)  MIME multipart (adjuntos) sobre el mismo cliente
server/report.ts          (queda)  importa schedule.ts; su lazo no cambia de semántica
packages/mira/…/validate  (cambia) delivery.channels nuevo contrato (§3.3) + deprecación de schedule inerte
packages/mira/mira.ts     (cambia) §6·bis deja de empujar html de pantalla; entrega pasa al serving
```

Los canales **viven en el serving, no como capabilities del Botler del render**. Racional: el catálogo de serving está endurecido a «conector enforcing + render/publish» (charter §2b, `packages/cli/src/run.ts:62-67`; `server/serve-rls.ts:512-515`) y una capability de envío dentro del render mezclaría el acto de *componer* (bajo una identidad) con el de *repartir* (a N identidades) — que D3 exige separados. `publicar-artefacto` queda como lo que es: un stub de archivo, no el modelo a seguir.

### 3.2 · Contratos centrales

```ts
// server/channels.ts
export interface ChannelDecl { id: string; type: 'email-smtp' | 'slack-webhook' | 'webhook'; /* + forma por tipo (smtp/from | url) */ }
export interface ChannelsConfig { channels: ChannelDecl[]; subscriptions: { alerts: AudienceRef[]; reports: AudienceRef[] } }
export interface AudienceRef { channel: string; to?: string[]; toGroup?: string }

/** Transporte de bajo nivel de un canal: sabe ENVIAR, no sabe QUÉ. */
export interface ChannelPort {
  id: string
  sendNotification(n: Notification, audience: ResolvedAudience): Promise<void>   // avisos (#100/#102)
  sendDelivery(d: DeliveryMessage, recipient: ResolvedRecipient): Promise<void>  // contenido de PI (D3: 1 llamada = 1 destinatario)
}

export interface DeliveryMessage {
  subject: string                 // p.ej. «Ventas semanales — semana del 2026-08-03»
  summaryLines: string[]          // título, vista, corte de datos, período
  link: string                    // enlace profundo a la pantalla (VERGIS_PUBLIC_URL + slug + nav)
  attachments: { filename: string; contentType: string; content: Uint8Array }[]  // pdf/csv YA renderizados para el destinatario
}

export interface ResolvedRecipient {
  email: string
  identity: IdentityContext       // enriquecida por el directorio; claims presentes o el envío NO ocurrió
}
```

`parseChannelsConfig` sigue el patrón exacto de `parseNotifyConfig`: fail-closed al boot, `requireRootKey`, ids únicos, `passEnv` resuelto en creación, validación cruzada (suscripción a canal inexistente rompe el arranque con el nombre — `server/notify.ts:102-137` como plantilla).

### 3.3 · El contrato del spec (`delivery` nuevo)

```yaml
delivery:
  render:
    - { format: html, target: web }
  channels:
    - channel: correo-institucional      # id del registro de la instancia (D1/D5)
      to_group: gerencia-comercial       # o to: [a@cliente.cl] — audiencia gobernada (D3.4)
      attach: [pdf]                      # pdf | csv (D2); default: solo cuerpo+enlace
      page: resumen                      # opcional: qué vista congela la entrega (PI multi-vista)
      schedule: { every: weekly, weekday: monday, at: "07:30", timezone: America/Santiago }  # gramática de #102 (D4)
```

Reglas de validación (mismo orden y estilo de `validate.ts`): `channel` debe existir en el registro de la instancia; `to`/`to_group` exactamente uno; `attach` ⊆ {pdf, csv} y `csv` exige que el PI tenga tablas (regla existente de `render-csv-piece`: sin tablas es fail-loud, `packages/capabilities/src/render-csv-piece.ts:9-11`); `schedule` obligatorio en v1 (la entrega on-event llega con el frente 07/#110 — sin runtime vivo no hay evento que escuchar). El schema JSON de `delivery` se cierra en el mismo cambio (hoy `{type: object}` libre — §1.4): el contrato pasa a estar declarado donde los autores lo leen.

### 3.4 · El ciclo de una entrega (delivery-loop)

Por cada entrega vencida (tick global de 60 s, `lastDueAt` compartido):

1. **Resolver audiencia**: `to_group` → `listMembers` en el momento (D3.4); lista final de emails.
2. **Por destinatario** (cap `VERGIS_DELIVERY_MAX_RECIPIENTS`, default 25 — `[aprobada por César · 2026-08-08]`, es un knob de gasto):
   a. identidad ← directorio; sin mapeo ⇒ **skip fail-closed** + registro + aviso `alerts` (D3.2);
   b. compuerta de artefacto: rol efectivo ≥ visor o skip fail-closed (D3.3);
   c. render bajo su identidad: `runPi(report, identidadDelDestinatario, {page}, undefined, {print: true})` → sidecar PDF, y/o `render-csv-piece` — los renders que la pantalla ya usa, con la MISMA identidad-por-consumidor que `runSpec` ya acepta (`packages/cli/src/run.ts:50-55`);
   d. `sendDelivery` por el canal.
3. **Idempotencia**: se persiste `last_sent` de la entrega cuando ≥1 destinatario recibió (semántica de `server/report.ts:508-517`); los skips fail-closed cuentan como *no entregado a esa persona* y quedan en el registro del período (`delivered/failed/skipped` por email).
4. **Auditoría**: evento en el log de gobierno con spec, canal, período, y el desglose por destinatario — la entrega es un acto auditable de la plataforma, como el reporte (`server/report.ts:513`).

### 3.5 · Semánticas de error

- Canal caído ⇒ error nombrado por destinatario, reintento del período según el patrón de #102; jamás tumba el tick de otros specs (aislamiento de `fanout` como referencia, `server/notify.ts:283`).
- Render fallido para UN destinatario ⇒ ese destinatario queda `failed`, los demás siguen — el fallo de la RLS de uno no puede callar la entrega de todos, ni al revés.
- Sidecar PDF ausente con `attach: [pdf]` declarado ⇒ la entrega del período **falla ruidoso** (no «se envía sin adjunto»: el destinatario no sabría que le faltó el documento — un éxito parcial silencioso es el modo de falla que #102 vino a matar).

---

## 4 · Plan de construcción

El horizonte es largo plazo (regla 5 del plan): H0–H2 son ejecutables hoy con contrato completo; H3–H4 tienen la arquitectura decidida (§2–§3) y sus detalles finos se re-verifican al destrabar (§5). Gates de todos los hitos: `npm run typecheck && npm test && npm run build` (los scripts reales de `package.json` — no existe script `lint`; no enmascarar exit codes con pipes).

**H0 — Dejar de prometer lo que no existe** *(ejecutable hoy, ~1 línea + tests)*
Territorio: `server/serve-rls.ts:1467`, test nuevo en la suite de Miranda.
Quitar `'send-email', 'send-slack'` de `MIRANDA_VALIDATE_CAPS`.
**Hecho cuando:** `grep -n "send-email" server/serve-rls.ts` devuelve vacío, y un test demuestra que `validateDraft` rechaza un draft con canal `send-email` con `channel-capability-not-catalogued` — el experimento que refuta (o confirma) la cadena de §1.4.

**H1 — Registro unificado de canales** *(ejecutable hoy)*
Territorio: `server/channels.ts` (nuevo), `server/instance-config.ts`, `server/serve-rls.ts:875-885`, `server/notify.ts` (los sinks se construyen desde el registro), tests.
`VERGIS_CHANNELS` + `parseChannelsConfig` fail-closed; alias `VERGIS_NOTIFY` con warning de deprecación (D1); alertas y reportes salen por suscripciones del registro.
**Hecho cuando:** boot con `channels.yaml` de ejemplo loguea el resumen de canales; los tests existentes de notify/report pasan sin cambio de semántica (mismos mensajes, mismos destinos); un test nuevo prueba el mapeo de compatibilidad NOTIFY→CHANNELS; boot con suscripción a canal inexistente **falla** nombrándolo.

**H2 — Adjuntos MIME** *(ejecutable hoy)*
Territorio: `server/smtp.ts` (`buildMime` multipart/mixed, `MailMessage.attachments`), tests con el arnés de conversación existente.
**Hecho cuando:** test round-trip: un mensaje con adjunto PDF y CSV produce MIME parseable (multipart, base64 por parte, filename RFC 2231 si no-ASCII) y el flujo sin adjuntos genera **byte-idéntico** al formato actual (no romper #102).

**H3 — Entrega de PI por canal** *(núcleo del frente; exige H1+H2 y decide destranque §5)*
Territorio: `server/schedule.ts` (extracción pura desde `report.ts` — refactor sin cambio de conducta, juez: tests de report intactos), `server/delivery-loop.ts`, `packages/mira/src/dsl/validate.ts` (contrato §3.3 + cerrar schema), `packages/mira/src/mira.ts` (retirar el push de HTML de pantalla del §6·bis), wiring en `serve-rls.ts`.
**Hecho cuando:** con el arnés local (dev identity + `VERGIS_IDENTITY_MAP` de prueba), un spec con `delivery` a dos destinatarios de claims distintos produce **dos PDFs con filas distintas** (el test de la fuga: si salen iguales, D3 está roto); un destinatario sin mapeo produce skip + aviso, no envío; el período se persiste y el segundo tick no re-envía.

**H4 — Miranda valida contra el registro real** *(post-H1)*
Territorio: `server/serve-rls.ts` (`MirandaServerDeps` + lista de canales inyectada), validador de drafts.
**Hecho cuando:** un draft con `channel: <id-existente>` valida OK y con `<id-inexistente>` es rechazado nombrando los ids disponibles.

---

## 5 · Destranque

**Qué habilita construir H3+** (H0–H2 no esperan a nadie): (a) **demanda concreta de una instancia** — un PI real que deba llegar por email/Slack a una audiencia con RLS; el issue que la registre fija los primeros parámetros reales (cadencia, adjuntos, tamaño de audiencia); y/o (b) **el frente 07 (Botler persistente)** si César decide que los lazos programados nazcan allá y no en serving — D4 funciona en ambos mundos, pero construir dos veces el wiring sería desperdicio.

**Qué re-verificar al destrabar** (partes sensibles a envejecer):

- **Frente 03 (#138·2, config recargable):** si prospera, el registro de canales debe nacer por esa vía (sinks re-creables, no congelados al boot como hoy — §1.3); re-leer su diseño antes de H1 si ya está resuelto.
- **Frente 06 (#110, webhook de Miranda/piezas):** cruce declarado en el plan del cluster (08↔06) — si ese frente creó otro tipo de canal o su propio transporte, se unifica en el registro D1 antes de duplicar.
- **`MIRANDA_VALIDATE_CAPS` y el contrato de `delivery`** pueden haber cambiado (el frente 02/#139-N3 toca el contrato de Miranda): re-medir §1.4 con grep antes de H0/H4.
- **`server/smtp.ts`**: si alguna necesidad intermedia (DKIM, colas) lo reemplazó por dependencia externa, H2 cambia de territorio.
- **El cap de audiencia y el costo del render por destinatario** (D3/§3.4): son `[propuesta]` sin dato real; la primera instancia con demanda los calibra con medición, no con este documento.

---

## 6 · Riesgos y no-metas

**Riesgos**

1. **Fuga por render compartido** — el riesgo central; mitigado por contrato (D3.1: prohibido repartir un render) y por el test-de-fuga de H3, que es el experimento que refutaría la garantía si se rompe.
2. **Costo N renders × destinatarios** — una audiencia grande con PDF es cara (render + sidecar por persona). Mitigación: cap por entrega (§3.4) y `to_group` que hace visible el tamaño real; sin medición aún (conjetura declarada en §5).
3. **Secretos que migran al lugar equivocado** — la migración D1 podría tentar a poner el token en el YAML «para simplificar». El patrón `passEnv`/`tokenEnv` es invariante (D5); el parser lo exige como hoy (`server/notify.ts:157`).
4. **Deriva de los dos relojes** — si H3 se construye sin extraer `schedule.ts`, reporte y entregas divergen en DST/catch-up. El plan lo hace refactor previo con juez (tests de report intactos).
5. **Adjunto re-enviable** — límite declarado, no defecto (D3.6): se comunica en la documentación de instancia para que el operador no asuma un control que no existe.

**No-metas**

- **Replicar el PI en HTML de correo** (D2): el fiel es el adjunto; el cuerpo es resumen + enlace.
- **Ser servidor de correo:** sin MX, colas, DKIM, gestión de rebotes — frontera ya sellada (`server/smtp.ts:6-8`, #102 «fuera de alcance») y se mantiene.
- **Slack API completa (bot token, files.upload, threads) en v1:** el incoming webhook cubre alertas/reportes/cuerpos; la API entra solo si una demanda real pide adjuntos en Slack — extensión del tipo de canal en el registro D1, no rediseño. *(Detalles de la API de Slack: no verificados en este trabajo — se investigan al destrabar esa extensión.)*
- **Suscripciones self-service del usuario final** («mándame este PI a mí»): exige superficie UI + gobierno propio; se diseña cuando el modelo D1–D3 esté en producción.
- **Entrega on-event** (un PI que se envía «cuando cambie el dato»): requiere el runtime vivo del frente 07; el contrato §3.3 la deja como extensión de `schedule`, no la promete.

---
• 🤖 Claude (Fable) · diseño del frente 08-113-canales-salida · cluster 004
