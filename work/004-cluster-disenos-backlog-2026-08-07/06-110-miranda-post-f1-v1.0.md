# 06 · Diseño #110 — Las piezas post-F1 de Miranda — v1.0

**Frente:** issue #110 «miranda: ampliaciones post-F1 (preview RLS · primer PI real · probes multi-DB · webhook de anuncios · scope)» · **Horizonte:** diferido POR PIEZA — cada sección declara el suyo.
**Método:** una sección por pieza, cada una con estado verificado, decisiones, contratos, plan y destranque propios. Las decisiones se numeran D1… global para citarse entre piezas.
**Nota de proceso del issue (aplica a todo el documento):** lo que toque **acceso o gasto** queda gated en la instancia que lo despliegue — cada pieza declara su gate de instancia en su sección.

---

## Estado actual verificado (transversal)

Lo que las cinco piezas comparten como terreno, medido en el código:

- **Miranda vive detrás de `MIRANDA_ENABLED`** (default off ⇒ superficie cero): `server/config.ts:97-117` (tipo `MirandaConfig`), `server/config.ts:339-356` (parseo, key obligatoria con flag ON), `server/serve-rls.ts:1425-1556` (bloque de cableado), `server/miranda.ts:79-393` (handler HTTP).
- **La RLS del dato es data-anchored y viaja por claims.** En fabric, el conector enforcing reinyecta TODOS los claims de la identidad vía `sp_set_session_context` antes de cada query, y la SECURITY POLICY de la fuente filtra por `SESSION_CONTEXT`; claim ausente se inyecta `''` ⇒ deny, no fuga (`packages/capabilities/src/execute-sql-dwh.ts:33-51,118-128`; unión de inyecciones fijada al arranque: `server/serve-rls.ts:350-364`). En clickhouse el conector también recibe `injections` (`server/serve-rls.ts:301`); *se asume* semántica simétrica (row policies por consumidor) — **conjetura, verificar al construir la pieza 1 sobre ese motor**.
- **La identidad se resuelve de cabeceras del gate + directorio.** `identityFor` = cabeceras oauth2-proxy → claims (`VERGIS_GATE_CLAIMS`), enriquecidos fail-closed desde `VERGIS_IDENTITY_MAP` (email → claims de directorio): `server/identity.ts:29-55`, `server/serve-rls.ts:438-444`.
- **La preview de un draft ya corre por el riel real.** `renderPreviewHtml` escribe el YAML a un tmp y lo pasa por `runSpec` con `identity: identityFor(headers)` — la identidad del request, la misma RLS que un PI publicado (`server/serve-rls.ts:1520-1541`; ruta GET `/miranda/preview/:id` en `server/miranda.ts:169-171,286-296`).
- **Las probes corren con identidad SIN claims contra UN solo destino.** `PROBE_REF = contract.env('MIRANDA_PROBE_DB') ?? primera conexión` (`server/serve-rls.ts:1468`); `probeIdentityOf` fabrica `{agent:'miranda-probe', user: email}` sin claims — el propio código lo declara «Fase 1: audiencia interna, dominios grant:all. TODO Fase 2: ligar la probe a la identidad autoritativa del autor» (`server/serve-rls.ts:1469-1471`). Consecuencia medible: sobre una tabla gobernada, la inyección de claims vacíos deja la probe en cero filas (fail-closed del punto anterior).
- **El webhook de anuncios EXISTE y hace exactamente una cosa.** `MIRANDA_ANNOUNCE_WEBHOOK` (`server/config.ts:116,354`) arma un closure que hace `POST {text}` (`server/serve-rls.ts:1544-1548`), invocado únicamente desde `publishSpec` con un mensaje fijo de publicación, envuelto no-fatal (`packages/miranda/src/publish.ts:29-31,110-114`). Sin timeout explícito, sin más eventos, sin vía para que el agente emita, sin auditoría del intento.
- **El cinturón de herramientas es un registro cerrado de 11 tools** (`packages/miranda/src/tools/registry.ts:44-…`, contratos documentados en `docs/miranda.md:75-88`), con guardia SQL en código (`packages/miranda/src/tools/sql-guard.ts:63-…`) y allowlist de catálogo por hoja del nombre (`server/miranda.ts:85-86`, shape `CatalogEntry` en `packages/miranda/src/tools/context.ts:10-15` — **sin campo de base de datos**).
- **Telemetría de serving: no existe.** El único log es el de auditoría **administrativa** (`server/serve-rls.ts:922` + appends en rutas admin); `runPi` (`server/serve-rls.ts:498-531`) no registra quién rindió qué PI ni cuándo. Verificado por grep de `telemetr|métrica|visita|pageview|contador` sobre `server/` (sin hits).
- **Hallazgo colateral (para el orquestador):** `handlePreview` NO verifica pertenencia de la sesión — cualquier identidad con scope `miranda` puede previsualizar el draft de una sesión ajena conociendo su id (`server/miranda.ts:159-171,286-296`: el único gate es el scope global de la línea 163). La RLS del dato sí aplica (ve con SU identidad), pero el YAML/estructura del draft ajeno queda expuesto. La pieza 1 lo sella (D3); puede adelantarse como fix independiente.

---

## Pieza 1 — Preview de RLS con dos identidades reales

**Qué es:** que Miranda muestre el mismo PI (draft) como lo vería cada identidad, convirtiendo «la política está declarada» en «la política hace lo que dice» sin montar el escenario a mano.

### Estado verificado

La preview actual ya rinde con RLS real, pero SIEMPRE con la identidad del request (`server/serve-rls.ts:1520-1541`). No existe mecanismo para rendir «como otro»: ni config, ni ruta, ni tool. La tool `render_preview` devuelve una única URL (`server/miranda.ts:132-136`; link en el panel: `server/miranda.ts:385`).

### Decisiones

**D1 — Suplantar claims en preview es un ROSTER declarado por la instancia, no un impersonate libre.** La instancia declara explícitamente qué identidades son inspeccionables en preview (`MIRANDA_PREVIEW_IDENTITIES` → archivo JSON). Sin roster, la feature **no existe** — ni parámetro `as`, ni links, ni tool ampliada (patrón `PdfConfig`: el binario es uno, `server/config.ts:84-94`). Una identidad fuera del roster se rechaza; jamás hay `?as=<email arbitrario>`.

*Racional — por qué NO es un bypass del gate (la decisión de seguridad central, sellada fail-closed):*

1. **El gate nunca se elude.** El gate autentica QUIÉN llega a la superficie; el actor sigue siendo el usuario autenticado por oauth2-proxy, con su scope `miranda` verificado (`server/miranda.ts:163-166`). Lo que cambia es el `IdentityContext` que alimenta el filtro RLS de UN render efímero server-side de un draft — nunca una cookie, nunca una sesión, nunca acceso a rutas.
2. **Los claims suplantados no amplían al actor más allá de lo declarado.** El render impersonado ve exactamente lo que el roster dice que esa identidad ve — y el roster lo escribió la instancia, no Miranda ni el actor. Es la nota del issue aplicada: decisión de **acceso** → gated en la instancia.
3. **Cada costura falla cerrada.** Sin roster → superficie cero. Etiqueta no rostered → 404. Claim que la política exige y el roster no trae → se inyecta `''` → cero filas (mecanismo ya vigente: `execute-sql-dwh.ts:33-35`, caveat `serve-rls.ts:359-363`). Motor sin inyecciones verificadas → el PI ya no es servible por el fail-closed por-PI existente (`server/serve-rls.ts:366-397`).
4. **Lo que sí es, se nombra:** una revelación deliberada — el actor ve lo que la identidad del roster vería. Ese es el propósito (verificar la política) y por eso el roster es la unidad de gobierno: la instancia decide QUÉ vistas son inspeccionables.

**D2 `[propuesta — revocable por César]` — El roster se puebla con identidades SINTÉTICAS (personas de prueba con claims realistas), no con empleados reales.** Recomendación operativa, no mecanismo: el mecanismo funciona con cualquier identidad. *Alternativa descartada:* derivar los claims de un email real vía `IdentityMap` + membresías — descartada porque (a) convierte a todo especificador en lector universal de las vistas de cualquier colega, y (b) sería **incompleta**: el claim de gate (`groups`, cabecera `x-forwarded-groups`) no vive en el directorio (`server/identity.ts:26-27,47-55`) — una impersonación a medias que se ve «verificada» es peor que ninguna.

**D3 — La preview (toda variante) exige pertenencia: dueño de la sesión o admin.** Sella el hallazgo colateral del estado actual. `createdBy` ya se persiste (`packages/capabilities/src/governance-store.ts:217-219,1040-1049`); falta solo el check en `handlePreview`.

**D4 — Cada render impersonado se audita.** Evento `miranda-preview-as` `{session, actor, as}` al `AppendOnlyLog` de auditoría (`server/serve-rls.ts:922`). El actor real queda siempre en el registro: la impersonación es trazable por construcción.

### Arquitectura y contratos

**Config** (en `MirandaConfig`, `server/config.ts`):

```ts
/** Ruta a JSON con las identidades inspeccionables en preview. Vacío = feature apagada. */
previewIdentitiesPath: string | undefined   // env MIRANDA_PREVIEW_IDENTITIES
```

**Archivo del roster** (config de instancia, junto al catálogo):

```jsonc
[
  { "label": "gerente-zona-norte", "user": "persona.norte@inst.test",
    "claims": { "groups": ["gerencia"], "area": ["Norte"] } },
  { "label": "vendedor-sur", "user": "persona.sur@inst.test",
    "claims": { "groups": ["ventas"], "area": ["Sur"] } }
]
```

Los claims son **inline y explícitos** (auditable de un vistazo qué ve cada etiqueta); el server los pasa TAL CUAL como `IdentityContext` — sin enriquecer desde `IdentityMap`, para que el roster sea la única fuente de verdad de lo suplantado. Validación al arranque: labels únicos, `user` y `claims` presentes; roster ilegible con Miranda ON → aborta (mismo patrón que la API key, `server/config.ts:342-344`).

**Server** (`MirandaServerDeps`, `server/miranda.ts:37-65`):

```ts
previewIdentities: { label: string; user: string }[]        // para UI/tool (sin claims: no viajan al cliente)
renderPreviewHtmlAs(draftYaml: string, label: string): Promise<string>  // lanza si label ∉ roster
```

`renderPreviewHtmlAs` reusa el cuerpo de `renderPreviewHtml` (`server/serve-rls.ts:1520-1541`) cambiando SOLO `identity`: el `IdentityContext` del roster en vez de `identityFor(headers)`. Mismo tmp, mismo `runSpec`, mismas capabilities — un solo riel de serving se mantiene como invariante.

**Rutas** (delta sobre `server/miranda.ts`):

| Ruta | Cambio |
|---|---|
| `GET /miranda/preview/:id` | + check de pertenencia (D3). Sin `as` ⇒ comportamiento actual (tu identidad). |
| `GET /miranda/preview/:id?as=<label>` | Render impersonado. Label inválido ⇒ 404 con mensaje. Audita (D4). |
| `GET /miranda/preview/:id/compare?a=<label\|me>&b=<label\|me>` | Página con DOS iframes lado a lado (mismo draft, dos identidades) + banda superior que nombra cada identidad. Es azúcar sobre `?as=` — cero lógica de datos propia. |

**UI:** el panel de sesión (`server/miranda.ts:385`) pasa de un link a una lista: «Ver con tu RLS» + un link por etiqueta del roster + «Comparar…» (dos selects → `/compare`). **Tool:** `render_preview` devuelve `{ url, identities: [{label, url}], compare_url }` — Miranda puede decirle al usuario «míralo como gerente-zona-norte vs vendedor-sur» con URLs concretas.

### Plan de construcción

1. **Config + roster.** `server/config.ts` (campo + parseo + validación), tests en `tests/` (patrón `miranda-flag.test.ts`). *Hecho cuando:* `npx vitest run tests/miranda-flag.test.ts` verde con casos roster-ausente/inválido/duplicado.
2. **Server: pertenencia + `renderPreviewHtmlAs` + `?as=` + auditoría.** `server/serve-rls.ts` (dep), `server/miranda.ts` (ruta + check D3). *Hecho cuando:* `npx vitest run tests/miranda-security.test.ts tests/miranda-handler.test.ts` verde con: sesión ajena ⇒ 403; label inválido ⇒ 404; label válido ⇒ render con claims del roster (assert sobre el `identity` que recibe el `runSpec` fake); evento de auditoría presente.
3. **UI compare + tool ampliada.** `server/miranda.ts`, `packages/miranda/src/tools/*`. *Hecho cuando:* `npx vitest run tests/miranda-tools.test.ts` verde + `npm run typecheck`.

**Juez global:** `npm test` && `npm run typecheck` (sin enmascarar exit codes).

### Horizonte y destranque

**Implementable ya** — ninguna brecha de F1 la bloquea. Gate de instancia (acceso): el roster; sin él, desplegar este código no cambia NADA observable. Sensible a envejecer: el refactor `createApp()`/A14 y el frente 03 (config recargable) pueden mover el bloque de cableado — re-verificar anclas de `serve-rls.ts` al construir.

---

## Pieza 2 — Primer PI real por Miranda (hito operacional)

**Qué es:** que un PI que sirve a usuarios reales nazca por la vía conversacional. Es un HITO del producto más que un feature: lo que se diseña es (a) la instrumentación que lo vuelve **medible** y (b) el cierre de las brechas de F1 que lo bloquean.

### Estado verificado

- La procedencia del PI publicado ya queda sellada en el YAML (cabecera con sesión/draft/fecha: `packages/miranda/src/publish.ts:60-70`) y en el store (`pi_code`, estado `publicado`).
- **No hay telemetría de serving** (ver transversal): hoy es imposible responder «¿alguien distinto del autor usó el PI?» sin revisar logs de proxy ajenos al producto.
- **Brecha F1 dura: la probe sin claims.** Sobre tablas gobernadas la probe ve cero filas (`server/serve-rls.ts:1469-1471` + fail-closed de inyección) — y un PI real casi por definición corre sobre dato gobernado. Miranda no puede reconciliar cifras del dominio real: el self-check pierde su insumo de realizabilidad.

### Decisiones

**D5 — El hito se define por datos del producto, no por declaración.** «Primer PI real» = las tres condiciones, cada una verificable por comando:
1. **Nació por Miranda:** existe sesión `publicado` con `pi_code` (query al store de gobierno).
2. **Sirve a otros:** la telemetría de serving (D6) registra ≥1 render exitoso de ese slug por un usuario ≠ `createdBy` de la sesión.
3. **Sigue siendo de Miranda:** el YAML servido es el publicado — el hash del contenido publicado (guardado al publicar como artefacto `published_hash` de la sesión) coincide con el hash del archivo vigente en `SPECS_DIR`. Una edición manual (que la cabecera de procedencia prohíbe, `publish.ts:63`) rompe la condición y el hito no cuenta.

**D6 — Telemetría de serving mínima: un evento por render de PI.** `AppendOnlyLog` separado del de administración (`${OUT}/serving-telemetry.log`): `{type:'pi-render', ts, slug, code, user, ok, ms, print}`. Se emite en `runPi` (`server/serve-rls.ts:498-531`) — un solo punto cubre HTML y PDF (el PDF es el mismo render en modo print, `serve-rls.ts:523`). Los emails son visibles solo para admins (mismo criterio que el log de auditoría existente). Superficie de lectura: una teja admin «uso por PI» (renders 7/30 días, usuarios distintos, último render) agregada on-demand desde el log — sin tabla nueva ni contador en caliente.

**D7 — Fase 2 de la identidad de probe: la probe corre con los claims del autor.** El seam `probe(sql, email)` (`server/miranda.ts:50-51,90-96`) pasa a `probe(sql, identity: IdentityContext)`, y `tryHandle` captura `identityFor(req.headers)` COMPLETO (no solo `.user`) al recibir el mensaje (`server/miranda.ts:162`, hoy descarta claims en `serve-rls.ts:1482`). Efecto: Miranda explora exactamente lo que su autor puede ver — ni más (no hay identidad de servicio privilegiada) ni menos (deja de estar ciega ante lo gobernado). `agent` se conserva `'miranda-probe'` para distinguirla en el motor. Es el «TODO Fase 2» del propio código, resuelto por el camino ideal: la probe ES un consumo con RLS.

### Plan de construcción

1. **D7 (identidad de probe).** `server/miranda.ts` (seam), `server/serve-rls.ts:1471-1495` (cableado; `columnsOf` conserva identidad sin claims — metadata de `INFORMATION_SCHEMA`, no filas). *Hecho cuando:* `npx vitest run tests/miranda-tools.test.ts tests/miranda-security.test.ts` verde con un caso que asevera que los claims del request llegan al conector fake.
2. **D6 (telemetría).** `server/serve-rls.ts` (emisión en `runPi`), `server/admin.ts` (teja de lectura — atención: el cyber-safeguard corta la revisión automatizada de ese archivo; prever checklist manual). *Hecho cuando:* test de integración que rinde un PI fake y encuentra el evento en el log; `npm test` verde.
3. **D5.3 (hash de publicación).** `packages/miranda/src/publish.ts` (+artefacto `published_hash`), comando/console de verificación. *Hecho cuando:* test de publish que altera el archivo y detecta la divergencia.

### Horizonte y destranque

Los TRES bloques de código son **implementables ya**. El HITO en sí se destranca cuando: (a) una instancia monta catálogo con las tablas reales del dominio (decisión de instancia), (b) pieza 1 disponible para la verificación pre-publicación, y (c) un especificador real adopta el flujo. El disparador operativo es la instancia GH (origen del pendiente `P-42` según el issue). Qué re-verificar al destrabar: que el catálogo de la instancia cubra el dominio del primer caso y que `MIRANDA_TOKEN_BUDGET` default (500k, `config.ts:351`) alcance para una sesión de dominio real — medirlo en la primera sesión, no estimarlo.

---

## Pieza 3 — Probes multi-DB

**Qué es:** rutear el sondeo de Miranda a varias bases, precondición de instancias con más de un `database_ref`.

### Estado verificado

- **Hoy el destino es UNO, fijado al arranque:** `PROBE_REF` (`server/serve-rls.ts:1468`) y usado en `probe` y `columnsOf` (`:1485,1493`). Documentado así (`docs/miranda.md:57`).
- **El motor de abajo YA es multi-DB:** `connections` es `{database_ref → perfil}` resuelto a call-time (`server/serve-rls.ts:236-250`), los specs declaran `database_ref` por data-entry (`server/engines/fabric.ts:87-92,183`), y el conector acepta cualquier ref del mapa. El cuello es exclusivamente el cableado de Miranda.
- **El allowlist compara por hoja del nombre** (`server/miranda.ts:85-86`, `sql-guard.ts:36-40`): dos bases con una vista homónima serían indistinguibles — el diseño debe resolver la ambigüedad, no heredarla.

### Decisiones

**D8 — El `database_ref` vive en el catálogo, por objeto.** `CatalogEntry` (`packages/miranda/src/tools/context.ts:10-15`) gana `database_ref?: string`. El catálogo ya es EL contrato de instancia sobre qué puede tocar Miranda; que también diga DÓNDE vive cada objeto mantiene una sola fuente de verdad y hace el allowlist naturalmente **por base**: un objeto solo es consultable en la base que su entrada declara. `MIRANDA_PROBE_DB` se conserva con semántica de **default**: entradas sin `database_ref` lo heredan (compatibilidad exacta con los catálogos existentes; con una sola conexión nada cambia).

**D9 — Una probe no cruza bases; la resolución de nombres es exacta-primero y falla ante ambigüedad.** Un `SELECT` no puede abarcar dos conexiones, así que el guard lo dice de frente: se resuelven los objetos referenciados (`referencedTables`, `sql-guard.ts:43-49`) contra el catálogo — nombre calificado exacto primero; por hoja solo si es inequívoco; hoja ambigua ⇒ error que lista los candidatos calificados; refs resueltos ≠ 1 ⇒ «una probe corre contra UNA base; estos objetos viven en bases distintas: …». Errores devueltos, no lanzados (patrón `tools.ts:4-5`).

**D10 — Validación de refs al arranque, fail-closed.** Todo `database_ref` del catálogo debe existir en `connections`; uno huérfano aborta el arranque de Miranda con el ref por nombre (mismo patrón eager de `parseConnections`, `serve-rls.ts:241-246`). Un catálogo que promete una base inexistente no debe degradar en silencio a errores de probe crípticos.

### Arquitectura y contratos

- **Paquete:** helper puro `resolveCatalog(catalog, defaultRef)` → `{ entryOf(name): CatalogEntry & {ref} | AmbiguityError | NotAllowed; refOfProbe(tables[]): ref | Error }` en `packages/miranda/src/tools/` (testeable sin server). `MirandaToolContext` no cambia de forma para el modelo: `runProbe/columnsOf/sampleRows/profileColumn` resuelven el ref internamente vía el helper.
- **Server:** `probe(sql, identity, ref)` y `columnsOf(table, ref)` (`server/serve-rls.ts:1484-1495`) — el ref viaja explícito hasta `servingCap.execute({database_ref: ref, sql})`.
- **Tool `catalog_tables`** expone `database_ref` en su salida (el modelo debe saber dónde vive cada objeto para no proponer joins imposibles) — `tools.ts:29-38`.
- **Docs:** fila de `MIRANDA_PROBE_DB` en `docs/miranda.md:57` pasa a «default de `database_ref` para entradas del catálogo que no lo declaren».

### Plan de construcción

1. **Helper de resolución + tests** (`packages/miranda/src/tools/`). *Hecho cuando:* `npx vitest run tests/miranda-sql-guard.test.ts tests/miranda-tools.test.ts` verde con: exacto-primero, hoja inequívoca, ambigüedad listando candidatos, cruce de bases rechazado.
2. **Cableado server + validación de arranque** (`server/serve-rls.ts`, `server/miranda.ts`). *Hecho cuando:* test de arranque con ref huérfano ⇒ aborta; probe a entrada con ref B llega al conector fake con `database_ref: 'B'`.
3. **Salida de `catalog_tables` + docs.** *Hecho cuando:* `npm test` && `npm run typecheck`.

### Horizonte y destranque

**Diseño previsor.** Destranque: la existencia de una instancia con ≥2 `database_ref` en `VERGIS_CONNECTIONS` (si alguna lo tiene hoy — sin confirmar desde el repo). Sensible a envejecer: la forma de `connections` y el hot-reload de perfiles (`serve-rls.ts:1628-1631`) — re-verificar que el swap in-place siga siendo la referencia viva que los refs resuelven a call-time.

---

## Pieza 4 — Webhook de anuncios: el delta

**Qué es:** que Miranda pueda emitir hacia un canal configurable, no solo responder en la conversación. **Lo ya construido no se rediseña**: se mide y se diseña el delta.

### Estado verificado (lo que el webhook hace HOY)

| Aspecto | Hoy |
|---|---|
| Config | `MIRANDA_ANNOUNCE_WEBHOOK` (URL única) — `config.ts:116,354` |
| Forma | `POST {text}` JSON (compatible Slack incoming-webhook) — `serve-rls.ts:1546` |
| Eventos | UNO: publicación de un PI, mensaje fijo — `publish.ts:110-114` |
| Fallos | try/catch no-fatal en publish; **sin timeout explícito**, sin auditoría del intento |
| Agente | Miranda NO puede emitir; el announce es del flujo publish, no una tool |

### Decisiones

**D11 — Un `Announcer` tipado por eventos; el transporte y el shape `{text}` se conservan.** El delta es de estructura, no de protocolo: la URL única y el POST Slack-compatible se quedan (cero migración de instancia). Lo que cambia: los eventos se centralizan en un módulo con timeout y auditoría.

```ts
// packages/miranda/src/announce.ts
type AnnounceEvent =
  | { kind: 'publicacion'; code: string; title: string; draftVersion: number; author?: string }
  | { kind: 'data_request'; descripcion: string; tablas: string[]; author?: string; sessionId: string }
  | { kind: 'agente'; texto: string; author: string; sessionId: string }        // ← la tool (D12)
interface Announcer { emit(e: AnnounceEvent): Promise<void> }  // JAMÁS lanza; formatea → POST {text}
createAnnouncer(opts: { url: string; timeoutMs: number; audit?: (e) => void }): Announcer
```

Timeout por `AbortSignal.timeout` (default 5000 ms, env `MIRANDA_ANNOUNCE_TIMEOUT_MS`); resultado de cada intento (`ok`/`error`, sin el cuerpo) al log de auditoría. Eventos nuevos del flujo: `data_request` (hoy el handoff se guarda en silencio, `server/miranda.ts:128-131` — es exactamente lo que un canal debe contar) además de la `publicacion` existente.

**D12 — Tool `announce` para el agente: side-effect gated doble, con procedencia forzada.** Nueva tool del cinturón, admitida por la rúbrica de la pieza 5 como efecto de egreso (clase R2):
- **Gate de instancia doble:** existe solo si hay URL **y** `MIRANDA_ANNOUNCE_AGENT` truthy (default off). El webhook es acceso a un canal ⇒ decisión de quien despliega (nota del issue).
- **Procedencia inescapable:** el texto sale SIEMPRE prefijado por el server — `🤖 Miranda (sesión <título>, <autor>): …` — la tool no puede hablar como humano ni anónima.
- **Tope en código:** máx. 3 emisiones por sesión (contador en el store); la 4ª devuelve error accionable al modelo.
- **Registro:** cada emisión se guarda como artefacto de sesión (`announce` vN) — el transcript y el canal cuentan la misma historia.

**D13 — Frontera con los canales de salida de PIs (frente 08): el announcer NUNCA transporta dato.** Ni filas, ni agregados, ni adjuntos — solo metadatos de eventos (códigos, títulos, autores, texto del agente). Los canales que entregan DATO de PIs (email/Slack como destinos de primera clase; las caps `send-email`/`send-slack` ya admitidas como válidas en drafts, `serve-rls.ts:1467`) son territorio del frente 08 del cluster. Esta frontera es de seguridad, no de organización: el webhook no pasa por RLS, así que no debe cargar nada que la RLS proteja.

### Plan de construcción

1. **`createAnnouncer` + migración de los dos call-sites** (`packages/miranda/src/announce.ts`, `publish.ts`, `server/serve-rls.ts:1544-1548`, `server/miranda.ts:128-131`). *Hecho cuando:* `npx vitest run tests/miranda-selfcheck-publish.test.ts` verde + tests nuevos: timeout no bloquea publish; fallo del webhook no revierte nada; `data_request` emite.
2. **Tool `announce`** (`packages/miranda/src/tools/`, flag en `config.ts`, tope en store). *Hecho cuando:* tests: sin flag ⇒ la tool no está en el registro (superficie cero); con flag ⇒ prefijo forzado, tope 3, artefacto persistido. `npm test` && `npm run typecheck`.

### Horizonte y destranque

El hito 1 es **implementable ya** (refactor + evento `data_request`). El hito 2 (tool del agente) queda **diferido** al destranque natural: la primera instancia con canal montado que pida voz del agente (previsiblemente junto al hito de la pieza 2). Gate de instancia: URL + flag; sin ellos, superficie cero.

---

## Pieza 5 — Ampliar el scope de herramientas: criterio de admisión

**Qué es:** el issue pide «ampliar el scope de herramientas disponibles al agente». Lo durable no es una lista cerrada — es el **criterio que hace admisible una herramienta**, aplicado como norma cada vez que alguien proponga una.

### Estado verificado

Once tools en registro cerrado (`registry.ts:44-…`; `docs/miranda.md:75-88`), con tres invariantes ya practicados: guardias en código y no en prompt (`sql-guard.ts`, gates de `publish.ts:73-100`), errores devueltos al modelo en vez de lanzados (`tools.ts:4-5`), y doctrina de lo prohibido (`docs/miranda.md:112-116`: ni DDL/DML, ni policies, ni gobierno). La única escritura al mundo es el YAML al publicar.

### Decisiones

**D14 — Rúbrica de admisión (la norma).** Una tool nueva se admite si y solo si pasa las seis pruebas; la clase determina el gate:

| # | Prueba | Qué exige |
|---|---|---|
| 1 | **Clase de efecto** | **R1 lectura** de superficie ya gobernada/expuesta (catálogo, specs, contrato, estado) ⇒ admisible con allowlist. **R2 efecto** (escritura, egreso, gasto) ⇒ además: gate de instancia propio (default off), tope en código y artefacto de sesión. **R3 gobierno** (policies, grupos, scopes, gates de publish) ⇒ **inadmisible** — Miranda no decide gobierno (`docs/miranda.md:112-116`). |
| 2 | **Fail-closed por construcción** | Sin su config, la tool NO aparece en el registro (superficie cero, patrón `PdfConfig`/`MIRANDA_ENABLED`) — nunca «aparece pero falla». |
| 3 | **Guardia en código** | Todo input pasa por un guard determinista con errores devueltos y accionables; el prompt jamás es la defensa. |
| 4 | **Gasto acotado** | Lo que gasta (modelo, motor, red) tiene tope en código imputado a la sesión (patrón `tokenBudget`/`TOP 500` forzado). |
| 5 | **Auditable** | Input relevante + motivo quedan en el registro (patrón `why` de `run_probe`); los efectos R2 además como artefacto de sesión. |
| 6 | **RLS intacta** | Si toca dato, corre por el conector enforcing con la identidad del autor (D7); si no pasa por RLS (egreso), no transporta dato (D13). |

**D15 — La cola de candidatas se evalúa con la rúbrica, no se congela acá.** Evaluación de las conocidas: `announce` → R2, admitida con el diseño de D12. `read_contract` (Miranda responde con el contrato operativo de su versión, #139 N3 — diseño del frente 02, que owns su contrato) → R1 **con juez por-invocación heredado del endpoint** (`/contrato` es superficie solo-admins; la tool queda siempre registrada y la autorización se resuelve al invocarla con el mismo predicado — el juez compartido es la forma que toma «allowlist» para una R1 cuya superficie es más estrecha que el scope de la sesión). `list_preview_identities` (labels del roster de la pieza 1, sin claims) → R1. Cualquier cosa que escriba terreno, corra DDL o toque policies → R3, cerrada por doctrina.

### Costura con el frente 02 (declarada, no diseñada dos veces)

**Este documento owns la NORMA de admisión (D14); el frente 02 (`02-139-n3-miranda-contrato`) owns el CONTRATO de su tool.** La costura exacta: la tool del frente 02 entra al cinturón como **R1** — lectura del contrato operativo de la versión corriente — con su registro incondicional al estar Miranda ON (el cinturón es fijo; la variabilidad por usuario rompería el prefijo cacheable) **y autorización por-invocación con el juez del endpoint** (`/contrato` es solo-admins; la tool deniega con los mismos textos — frente 02, D3). Todo lo demás (shape de la respuesta, fuente del contrato, denegaciones, versionado) es del frente 02.

### Plan de construcción

La rúbrica se adopta como parte de la doctrina: sección nueva «¿Cómo se admite una herramienta?» en `docs/miranda.md` (D14 tal cual) — territorio de un PR de documentación. *Hecho cuando:* la sección existe y la PRÓXIMA tool admitida (previsiblemente la del frente 02 o D12) referencia su clase en el PR que la introduce.

### Horizonte y destranque

La norma es **adoptable ya** (costo: un PR de docs). Se activa de verdad con la primera tool nueva — disparador: frente 02 o el hito 2 de la pieza 4.

---

## Riesgos y no-metas del frente

**Riesgos:**
- **P1 — el roster miente.** Si la instancia declara claims que no reflejan a nadie real, la verificación «pasa» sobre una ficción. Mitigación parcial: D2 (sintéticas con claims realistas) + la banda de la página compare nombra los claims usados (transparencia del experimento). El riesgo residual es de instancia, no de mecanismo.
- **P2/D7 — probes con claims del autor cambian lo que Miranda ve.** Sesiones F1 que «funcionaban» sobre dominios grant:all pueden empezar a ver menos si el autor tiene RLS estrecha. Es el comportamiento correcto (el autor especifica lo que puede ver), pero hay que anunciarlo en el changelog del despliegue.
- **P3 — resolución por hoja heredada.** Catálogos existentes con nombres no calificados siguen funcionando por el default-ref, pero la primera instancia multi-DB con homónimos verá errores de ambigüedad; el error lista candidatos precisamente para que el catálogo se corrija en minutos.
- **Transversal — anclas de `serve-rls.ts`.** El refactor A14/createApp y el frente 03 (config recargable) mueven ese archivo: TODA ancla de este documento se re-verifica al construir cada pieza (Norma 6; los números de línea son del árbol al 2026-08-07, commit `4d2e622`).

**No-metas:**
- Impersonación fuera de la preview de drafts de Miranda (nada de «ver el índice como X» ni PIs publicados como otro — si algún día se quiere, es OTRO diseño con su propia decisión de seguridad).
- Editor de roster/catálogo en la UI admin (los archivos de instancia se gestionan por el flujo versionado, Ley de Wingworking Norma 5).
- Retry/cola del webhook (no-fatal + timeout basta para anuncios; una cola es sobre-ingeniería sin un caso que la pida).
- Joins cross-DB en probes (imposible en un SELECT contra una conexión; se rechaza con claridad, no se emula).
- El modelo de niveles de Miranda (doctrina de instancia, excluido por el propio issue).

---
• 🤖 Claude (Fable) · diseño del frente 06-110 · cluster 004
