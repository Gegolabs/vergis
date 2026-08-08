# Diseño · #107 fase 2 — publicar definiciones de jobs en el motor desde Vergis — v1.0

**Frente:** #107 fase 2 (gate humano) · **Horizonte:** previsor — hito cero ejecutable ya; todo lo demás condicionado a su resultado y marcado como tal.

**Tesis en una línea:** Vergis publica la **cáscara** del job (el item del motor que apunta al código del convertidor), nunca el código del convertidor — misma separación de #62/#63: *Vergis declara y propaga, el convertidor ejecuta*. Y antes de diseñar sobre una API que nadie ha ejercido contra el tenant, se corre **un experimento que la pone en riesgo** (hito cero), con gate humano en ambos extremos.

---

## 1 · Estado actual verificado

Todo con ancla; lo no corrido contra el tenant se etiqueta.

**Lo que la costura con el motor hace hoy — y lo que no:**

- La costura `IngestionEngineClient` expone exactamente cuatro operaciones: `listRunHistory`, `getScheduleSeconds`, `setScheduleSeconds`, `setScheduleEnabled` (`packages/capabilities/src/ingestion-observability.ts:300-311`). Ninguna autora items.
- Las únicas superficies de la API de Fabric que el repo toca son tres URLs: disparo de corrida `POST …/items/{id}/jobs/instances` (`packages/capabilities/src/intake-onelake.ts:193`), lectura de corridas `GET …/items/{id}/jobs/instances` (`intake-onelake.ts:232`) y schedules `…/items/{id}/jobs/{jobType}/schedules` (`packages/capabilities/src/fabric-engine.ts:62`). Un grep por `createItem`/`getDefinition`/`updateDefinition`/`POST /items` no arroja nada más — **no existe ningún camino de autoría de items en el código** (verificado 2026-08-07).
- El `EngineRef` (workspace + item + jobType) es el conector proceso↔item del motor (`packages/capabilities/src/governance-store.ts:116-123`); un proceso sin `EngineRef` no es observable (`fabric-engine.ts:10-11`).

**La credencial:**

- Todo lo que habla con Fabric usa el puerto de credencial de #66 (`packages/capabilities/src/aad-token.ts`): modos `secret`/`federated`/`imds`, caché por scope, `SCOPE_FABRIC = 'https://api.fabric.microsoft.com/.default'` (`aad-token.ts:275`).
- Que el SP del intake tiene concedidos run-now, run-history y schedules en el tenant **se asume por la operación vigente** de Frescura y Cargas (el código los ejerce en producción) — sin corrida en esta sesión que lo re-mida. Qué permisos adicionales exige la *autoría* de items es exactamente lo que el hito cero mide.

**La fase 1 (mergeada — PR #132), que este diseño debe respetar:**

- Gestión in-app del registro de fuentes/procesos/salidas/mapeos en `/admin/sources`, **solo admin de plataforma**: el steward no-admin recibe 403 en el GET y en todo POST (`tests/admin-sources.test.ts:71-79`); sin `sourcesAdmin` cableado la página no ofrece un solo form — regresión cero (`tests/admin-sources.test.ts:90`); toda escritura con CSRF y audit `type: 'sources-write'` (`tests/admin-sources.test.ts:68,202`).
- Precedencia runtime-sobre-semilla: lo gestionado in-app (`managed`) sobrevive a la re-siembra de `sources.yaml`; una baja deja tombstone (`governance-store.ts:147-175`).
- Pausa por steward de dominio: apaga alerta y reconcile, nunca la observación; el lazo jamás re-habilita lo que un steward pausó (`server/freshness-loop.ts:19-23,196`). El check de steward: admin override o correo declarado en el dominio (`packages/capabilities/src/domain.ts:53-58`).

**El terreno del convertidor (la frontera que no se cruza):**

- El código del convertidor vive en el lakehouse de la instancia, `Files/code/…` (`packages/capabilities/src/run-logs.ts:21`, `intake.ts:356`); Vergis no parsea planillas ni ejecuta transformaciones (ADR-001, citado en `docs/gestion-de-dominio.md:136-137`).
- Ya existe el precedente exacto de la separación declarar/ejecutar: el manifiesto de reversión de #63 — Vergis deja el manifiesto, el convertidor ejecuta el DELETE, y sin la declaración `revert_delete` de la instancia todo es fail-closed (`docs/gestion-de-dominio.md:186-207`, `packages/capabilities/src/intake-revert.ts:18`).
- El patrón de acción destructiva en dos fases con plan sellado por hash (plan → confirmar → ejecutar; hash contra carreras) ya está construido y probado en «Revertir esta carga» (`server/admin-cargas.ts:58-66,232-250`).

**Config de instancia y gates:**

- Las configs declarativas se cargan fail-closed y fatales al arranque, un env por archivo (`server/instance-config.ts:61-118`) — el molde para declarar plantillas.
- Gates del repo: `npm run typecheck` (tsc) y `npm test` (vitest run) (`package.json:13-18`). Precedente de sondas manuales: `scripts/*-smoke.ts`.

**Sobre la API de autoría de Fabric:** todo lo que este documento afirma de ella (§3) proviene de la documentación pública de Microsoft — **no verificado contra el tenant**. No es un descuido: es la razón de ser del hito cero. Ninguna parte condicionada de este diseño se construye antes de esa corrida.

---

## 2 · Decisiones selladas

- **D1 — El hito cero es bloqueante y es un experimento, no una lectura.** Nada de la fase 2 se implementa antes de una corrida contra el tenant que habría salido distinta si la hipótesis «el SP puede publicar items» fuera falsa (Norma 7). Leer la documentación de la API y que calce no es medir. El instrumento se construye primero y debe **demostrar que sabe reportar su propio fallo** (§3, pasos A/A2).
- **D2 — Publicar ≠ autorar el convertidor.** Vergis publica el *item* del motor (SJD/pipeline): nombre, tipo, y una definición que **apunta** al código del convertidor en `Files/code/…` del lakehouse de la instancia. El código, el contrato de ingesta y el QC siguen siendo terreno instancia/convertidor. Vergis jamás escribe en `Files/code`.
- **D3 — Las plantillas son de la instancia y viven en su config.** Un manifiesto `VERGIS_JOB_TEMPLATES` (mismo molde que `VERGIS_SOURCES`: env → YAML → parse fail-closed al arranque, `instance-config.ts`) declara las plantillas; las *partes* de definición (JSON del item, con placeholders) son archivos junto al manifiesto, en el repo de la instancia. **Las versiona el flujo del repo de la instancia** (repo → despliegue, Ley de Wingworking Norma 5) — no un editor in-app. Cada plantilla lleva `version` explícita.
  - *Alternativa descartada:* plantillas en el lakehouse (`Files/code/_templates`), leídas vía OneLake. Descartada porque la parte de definición es **config del item**, no código del convertidor: mezclaría terrenos, perdería la validación fatal al arranque y quedaría fuera del flujo versionado del repo de instancia.
- **D4 — Rol: publicar es acto de plataforma → solo admin, fail-closed, coherente con fase 1.** Misma superficie (`/admin/sources`), mismo corte que el registro de fuentes: steward 403 en todo; sin plantillas declaradas **o** sin cliente de autoría cableado, la UI no ofrece un solo form (regresión cero, contrato idéntico a `tests/admin-sources.test.ts:90`). Stewards conservan exactamente lo de fase 1 (pausa/reanudación). CSRF + audit en toda escritura.
- **D5 — Dos fases con plan sellado por hash (patrón #63).** Publicar muestra primero el **plan derivado** — crear vs actualizar, workspace e item destino, plantilla@versión, sha256 de la definición renderizada, y el *drift* si el motor difiere de lo último publicado — y solo con confirmación ejecuta. El hash del plan protege contra carreras: si el estado cambió, 409 con el plan fresco.
- **D6 — Ledger append-only + el motor como autoridad.** Toda publicación (exitosa, denegada, fallida o desconocida) queda en `job_publication` (SQLite de gobierno). El estado vigente del item lo dice el motor (`getDefinition`); el ledger es la memoria de lo publicado desde Vergis. El drift (alguien editó el item en Fabric) **se muestra, jamás se auto-corrige** — el motor es terreno donde también opera la instancia.
- **D7 — Éxito solo por read-back.** Una publicación se declara `ok` únicamente cuando el `getDefinition` posterior devuelve el sha publicado. LRO que no culmina en la ventana → outcome `desconocida` (con el operationId registrado), re-observable después — nunca «publicado» sin la corrida que lo demostraría falso.
- **D8 — Vergis no borra items del motor.** `[aprobada por César · 2026-08-08]` La baja de un proceso en Vergis deja el item del motor intacto (tombstone solo del lado Vergis, con aviso en la UI de que el item sigue en el motor). *Alternativa descartada:* delete espejado — descartada porque borrar el item destruye su run-history (evidencia operacional) y el motor es terreno compartido con la instancia.
- **D9 — Credencial de autoría separable.** `[aprobada por César · 2026-08-08 — involucra permisos del tenant]` La config permite declarar un **perfil de credencial propio** para la autoría (mismo puerto de #66); recomendado si el hito cero muestra que autorar exige elevar permisos: así el camino de serving nunca porta un token capaz de reescribir definiciones. Default pragmático: el mismo SP del intake, si el hito cero demuestra que ya alcanza. *Alternativa descartada:* elevar el SP único incondicionalmente — amplía el radio de daño de todo el proceso servidor.
- **D10 — La publicación desemboca en la fase 1, no la duplica.** Al culminar un create, Vergis escribe el `engine_ref` sobre el proceso (upsert `managed`): desde ahí observabilidad, cadencia, pausa y reconcile son los caminos de fase 1 sin tocar. Publicar es el eslabón que faltaba antes de esa cadena.
- **D11 — Render de placeholders sobre JSON parseado, no sobre texto.** Los parámetros se sustituyen como **valores string dentro del JSON ya parseado** de cada parte (`{{param}}` debe ser el valor completo de un string JSON), nunca por concatenación de texto: un valor de parámetro no puede romper la estructura de la definición ni inyectar claves. Placeholder sin valor → error; valor sin placeholder → error.
- **D12 — Workspace de la sonda.** `[aprobada por César · 2026-08-08]` El hito cero se corre contra el **workspace real** con items de nombre reservado `vergis_probe_<epoch>` (creación + borrado inmediato), salvo que César designe un workspace sandbox. Racional: medir contra el terreno real es lo único que responde la pregunta real (permisos son por workspace); el prefijo y la limpieza acotan el residuo. La alternativa sandbox mide otro workspace y deja la pregunta abierta.

---

## 3 · Hito cero — el experimento con gate humano

**Pregunta que responde:** ¿puede el SP de esta instancia crear, leer, actualizar y borrar la definición de un item ejecutable (SJD/pipeline) en el workspace del tenant, vía la API pública de Fabric?

**Lo que la documentación pública afirma y esta corrida pone en riesgo** (todo esto es *conjetura hasta la corrida*):

| # | Endpoint | Semántica esperada |
|---|---|---|
| 1 | `POST /v1/workspaces/{ws}/items` con `{displayName, type, definition: {parts: [{path, payload, payloadType: 'InlineBase64'}]}}` | 201, o 202 + `Location`/`x-ms-operation-id` (long-running) |
| 2 | `GET /v1/operations/{operationId}` (+ `/result`) | poll del LRO hasta `Succeeded`/`Failed`, con `Retry-After` |
| 3 | `POST /v1/workspaces/{ws}/items/{id}/getDefinition` | 200/202 con las mismas parts |
| 4 | `POST /v1/workspaces/{ws}/items/{id}/updateDefinition` | 202 LRO |
| 5 | `DELETE /v1/workspaces/{ws}/items/{id}` | 200 |
| 6 | Parte principal esperada: SJD → `SparkJobDefinitionV1.json`; pipeline → `pipeline-content.json` | la sonda lo confirma leyendo lo que el motor devuelve |

**Permisos del SP en juego** (conjetura hasta la corrida; la sonda registra el `errorCode` que nombre lo que falte): tenant switch «Service principals can call Fabric public APIs» habilitado, y SP con rol **Contributor o superior** en el workspace. Hoy el SP ejerce run-now/run-history/schedules (§1) — la autoría puede exigir más, o no: eso es lo que se mide.

### El instrumento

`scripts/probe-item-authoring.ts` (precedente: `scripts/admin-smoke.ts`), standalone, credencial por el puerto de #66 con el perfil que indique la config. Imprime **por paso**: método, URL, status HTTP crudo, `errorCode` del cuerpo si viene, y el veredicto del paso. Nunca resume sin los crudos.

**Calibración del instrumento primero (Norma 7, corolario de instrumentos)** — antes de creerle una medición, la sonda demuestra que distingue «medí negativo» de «no pude medir»:

- **Paso A — control positivo:** `GET …/items/{itemConocido}/jobs/instances` con el mismo token (el camino que la producción ya ejerce). Falla ⇒ el instrumento/token/red está roto ⇒ **NO PUDE MEDIR** — la corrida se detiene y no concluye nada sobre autoría.
- **Paso A2 — control negativo:** `GET …/items/{uuid-inexistente}/jobs/instances` esperando 404. Si la sonda no reporta ese 404 como tal, la sonda miente y se arregla antes de seguir.

**La medición** (solo con A y A2 verdes):

- **Paso B — crear:** `POST items` tipo `SparkJobDefinition`, nombre `vergis_probe_<epoch>`, definición mínima válida. Si 202: poll del LRO hasta veredicto o tope (120 s).
- **Paso C — read-back:** `getDefinition` del item creado; comparar las parts con lo enviado.
- **Paso D — encadenar con fase 1:** `POST …/jobs/sparkjob/schedules` sobre el item de prueba (el código de `fabric-engine.ts` ya sabe hacerlo) — demuestra la cadena completa que la fase 2 necesita: *crear → agendar*.
- **Paso E — limpiar:** `DELETE` del item; verificación de que ya no está (GET 404). Si la limpieza falla, la sonda **lo dice** y deja el nombre exacto del residuo `vergis_probe_*` para retiro manual — nunca silencio.

### Matriz de veredictos — qué corrida demuestra qué

| Resultado observado | Veredicto |
|---|---|
| A✓ A2✓ · B crea (201/202→Succeeded) · C devuelve las mismas parts · D agenda | **«Se puede publicar»** — positivo medido, cadena completa. Destranca §4–6. |
| A✓ A2✓ · B responde 401/403 **con `errorCode` de Fabric**, reproducido en una segunda corrida | **«No se puede (hoy)»** — negativo medido, con el código que nombra la pieza que falta (tenant switch vs rol de workspace vs principal no soportado). No es fallo del instrumento: A probó el camino con el mismo token. |
| A falla · o B/C con 5xx, timeout, o error de red | **«No pude medir»** — cero conclusión. Se arregla el instrumento o se reintenta; jamás se registra como negativo. |
| B ok pero C no devuelve lo enviado (LRO sin culminar, parts distintas) | **«Publicación no confiable»** — no concluir; volver a medir. Si es reproducible, es un hallazgo en sí (la API acepta y no persiste) y se sella con sus crudos. |

Un 4xx **una sola vez** no es veredicto: se exige la segunda corrida con el mismo código (descarta transitorio). N corridas verdes tampoco «demuestran» de más: el veredicto positivo lo sostiene la cadena B+C+D medida, no el conteo.

### El gate humano — dos compuertas

1. **Antes de correr:** la sonda **escribe en el tenant** (crea y borra un item). César aprueba: (i) correrla, (ii) el workspace (D12), (iii) con qué perfil de credencial. Sin ese OK la sonda no se ejecuta — este diseño solo la deja lista.
2. **Después de correr:** el resultado se sella como **comentario en #107** con los crudos (status + errorCode por paso), y César decide la rama:
   - **Positivo** → se construye §4–6 tal cual.
   - **Negativo por permisos** → decisión de César: elevar el SP (o crear el perfil de autoría de D9) y re-correr, o dejar la fase 2 diferida con el errorCode como disparador documentado.
   - **Negativo estructural** (la API no soporta SP para autoría de estos tipos de item) → la fase 2 se rediseña (rutas alternativas: Git integration de Fabric, deployment pipelines — fuera de este documento) y este diseño queda como registro del camino descartado.

**«Hecho cuando» del hito cero:** existe el comentario en #107 con la matriz clasificada y los crudos, y la decisión de César registrada. Juez: César.

---

## 4 · Modelo de publicación *(condicionado al veredicto positivo del hito cero)*

Todo §4–6 se construye **solo** tras el destranque de §3. Se diseña con el criterio de excelencia: el camino ideal, con lo construido como dato.

### Qué es publicar

Un admin toma un **proceso** del registro (o lo crea, fase 1) y le publica su job en el motor a partir de una **plantilla de la instancia**:

```
plantilla@versión + parámetros ──render──▶ definición (parts) ──plan──▶ confirmar ──▶ motor
                                                │                                      │
                                                └── sha256 ──────── ledger ◀── read-back (sha)
                                                                       │
                                                        engine_ref → proceso (fase 1 desde aquí)
```

### Plantillas de la instancia (D3)

`VERGIS_JOB_TEMPLATES` → `job-templates.yaml` en el repo de la instancia, junto a sus partes:

```yaml
templates:
  - id: sjd_ingesta_excel
    label: "Ingesta Excel (SJD estándar)"
    version: "1.0"                      # la versiona el repo de la instancia
    itemType: SparkJobDefinition        # jobType de fase 1: sparkjob
    params:
      - { name: main_file,    label: "Script principal (abfss)", required: true }
      - { name: lakehouse_id, label: "Lakehouse por defecto",    required: true }
    parts:
      - { path: SparkJobDefinitionV1.json, file: parts/sjd-ingesta-excel.json }
```

- La parte (`parts/sjd-ingesta-excel.json`) es el JSON del item con placeholders `{{main_file}}`, `{{lakehouse_id}}` **como valores string completos** (D11). El `main_file` apunta al código del convertidor en su terreno (`Files/code/…`) — la frontera de D2.
- Carga fail-closed al arranque (molde `instance-config.ts`): manifiesto sin clave raíz, parte inexistente, placeholder no declarado o parámetro sin placeholder → el arranque **no** levanta, nombrando env + ruta + detalle.
- Quién las versiona: el repo de la instancia, con su flujo repo→despliegue. Vergis registra `template_id@version` en cada publicación; no edita plantillas in-app.

### Versionado de definiciones (D6, D7)

- Identidad de una publicación: `sha256` de la definición renderizada (concatenación canónica `path + '\n' + payloadBase64` de las parts ordenadas por path).
- `job_publication` (append-only, SQLite de gobierno — mismo db que fase 1):

```sql
CREATE TABLE IF NOT EXISTS job_publication (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id        TEXT NOT NULL,
  template_id       TEXT NOT NULL,
  template_version  TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  item_id           TEXT,              -- NULL hasta que el create culmine
  action            TEXT NOT NULL,     -- 'create' | 'update'
  definition_sha256 TEXT NOT NULL,
  params_json       TEXT NOT NULL,     -- valores del render (nunca secretos)
  outcome           TEXT NOT NULL,     -- 'ok' | 'denegada' | 'fallida' | 'desconocida'
  detail            TEXT,              -- errorCode / operationId / mensaje
  by_user           TEXT,
  at                TEXT NOT NULL
);
```

- **Drift:** al derivar el plan se hace `getDefinition` del item vigente y se compara su sha con el último `outcome='ok'` del ledger. Difieren ⇒ el plan lo declara («la definición en el motor no es la última publicada desde Vergis») y la confirmación exige verlo. Nunca auto-corrección (D6).
- Re-publicar = `updateDefinition` + fila nueva. La historia completa de qué se publicó, con qué plantilla y por quién, vive en el ledger; el estado vigente, en el motor.

### Permisos y fail-closed por rol (D4)

| Actor | Puede |
|---|---|
| Admin de plataforma | ver la sección, derivar plan, publicar (create/update) |
| Steward de dominio | lo de fase 1 (pausa/reanudación; cargas de su dominio) — **403 en publicación** |
| Resto | nada (fase 1 sin cambios) |

Fail-closed en tres capas: sin `VERGIS_JOB_TEMPLATES` → la sección no existe; sin cliente de autoría cableado (credencial no resuelta) → cero forms (contrato de regresión cero de fase 1); rol insuficiente → 403 antes de tocar nada. CSRF en todo POST; audit `type: 'jobs-publish'` con `op`, `process`, `template@version`, `sha`, `outcome`.

### Qué queda de cada lado (D2)

| Instancia / convertidor | Producto (Vergis) |
|---|---|
| Código del convertidor (`Files/code/…`) y su despliegue | Orquestación de publicación (render, plan, LRO, read-back) |
| Plantillas (manifiesto + parts) y su versionado en su repo | Carga/validación de plantillas, ledger, drift |
| Contrato de ingesta (logs `[delta]`/`✖`, `revert_delete`, sidecars) | UI admin, roles, CSRF, audit |
| El motor mismo (workspaces, capacidades, items pre-existentes) | `engine_ref` → cadena fase 1 (observar/agendar/pausar) |

---

## 5 · Arquitectura y contratos *(condicionado)*

**Módulos nuevos** (cortes por testeabilidad, mismo estilo del repo):

- `packages/capabilities/src/fabric-authoring.ts` — puerto + implementación Fabric:

```ts
export interface DefinitionPart { path: string; payloadBase64: string }
export interface ItemDefinition { parts: DefinitionPart[] }

export interface ItemAuthoringClient {
  /** 201/202+LRO. Lanza AuthoringDenied | AuthoringConflict | AuthoringUnknown. */
  createItem(ws: string, decl: { displayName: string; type: string; description?: string; definition: ItemDefinition }): Promise<{ itemId: string }>
  /** null = el item no existe (404). */
  getDefinition(ws: string, itemId: string): Promise<ItemDefinition | null>
  updateDefinition(ws: string, itemId: string, def: ItemDefinition): Promise<void>
}
```

  Taxonomía de error sellada: `AuthoringDenied` (401/403; porta el `errorCode` crudo), `AuthoringConflict` (nombre en uso), `AuthoringUnknown` (LRO sin culminar; porta `operationId`). LRO: poll con `Retry-After`, tope 120 s. `TokenSource` + `SCOPE_FABRIC`, fetch inyectable — mismo molde que `fabric-engine.ts`.

- `packages/capabilities/src/job-templates.ts` — parser (`parseJobTemplatesConfig`) y render (`renderTemplate(tpl, partFiles, values) → { parts, sha256 }`), puro, con las reglas de D11.
- `packages/capabilities/src/job-publication.ts` — DDL + ops puras sobre `SqlDb` (patrón `admin-roles.ts`) y `derivePublishPlan` (puro): decide create/update, computa drift, sella `hash` del plan.
- `server/admin.ts` — sección «Publicación de jobs» dentro de `/admin/sources`; rutas `POST /admin/sources/publish-plan` (deriva y muestra) y `POST /admin/sources/publish-exec` (hash sellado; 409 + plan fresco si no calza — patrón `revert-plan`/`revert-exec` de #63).
- `server/serve-rls.ts` — wiring: el publisher se construye **solo** si hay plantillas cargadas y credencial resuelta (opcionalmente el perfil de D9); se inyecta a `createAdmin` como dependencia opcional.

**Semántica de resultados** (D7): `ok` solo con read-back de sha; `denegada` con errorCode; `fallida` con mensaje; `desconocida` con operationId y acción «Re-verificar» en la UI (re-observa por `getDefinition` y resuelve la fila).

---

## 6 · Plan de construcción

**H0 — El instrumento y su corrida (hito cero; ÚNICO hito no condicionado).**
Territorio: `scripts/probe-item-authoring.ts` (archivo nuevo; ningún otro).
Contenido: los pasos A/A2/B/C/D/E de §3, crudos por paso, matriz de veredicto impresa al final; workspace/credencial por flags — **sin defaults que escriban**: sin flags explícitos, la sonda imprime qué haría y sale.
Hecho cuando: (1) `npm run typecheck` verde; (2) corrida en seco (sin flags) muestra el plan sin tocar red; (3) **con el OK de César**, corrida real ejecutada y su matriz + crudos sellados como comentario en #107; (4) decisión de César registrada en el issue.
Juez: César (gate humano); gates mecánicos: typecheck.

*Los hitos H1–H5 son **[condicionados al veredicto positivo de H0]** — un Opus no los arranca sin el comentario de destranque en #107. Juez mecánico de todos: `npm run typecheck && npm test` (`package.json:13-18`); territorio disjunto por hito.*

**H1 — Capability de autoría.** Territorio: `packages/capabilities/src/fabric-authoring.ts`, `packages/capabilities/src/index.ts` (export), `tests/fabric-authoring.test.ts`. Casos: 201 directo; 202+LRO→Succeeded; LRO timeout→`AuthoringUnknown` con operationId; 403+errorCode→`AuthoringDenied` portándolo; conflicto de nombre; `getDefinition` 404→null. Hecho cuando: `npx vitest run tests/fabric-authoring.test.ts` verde y ningún test existente roto.

**H2 — Plantillas.** Territorio: `packages/capabilities/src/job-templates.ts`, export, `tests/job-templates.test.ts`, `server/instance-config.ts` (env `VERGIS_JOB_TEMPLATES`), `examples/` (plantilla de muestra). Casos: parse válido; clave raíz ausente→error nombrado; placeholder no declarado / parámetro sin placeholder→error; render D11 (un valor con `"` o `}` no rompe el JSON); sha estable ante reorden de parts. Hecho cuando: vitest verde + arranque con ejemplo declarado muestra el conteo en el summary.

**H3 — Ledger y plan.** Territorio: `packages/capabilities/src/job-publication.ts`, export, `tests/job-publication.test.ts`, `packages/capabilities/src/governance-store.ts` (DDL en `open`). Casos: create vs update según ledger+motor; drift detectado; hash del plan cambia si cambia cualquier insumo; outcomes registrados los cuatro. Hecho cuando: vitest verde.

**H4 — Flujo admin.** Territorio: `server/admin.ts`, `tests/admin-jobs-publish.test.ts` (arnés calcado de `tests/admin-sources.test.ts`). Casos: steward 403 en GET-sección y POSTs; sin publisher cableado cero forms; plan→exec feliz escribe ledger + `engine_ref` managed + audit; hash viejo→409 con plan fresco; CSRF inválido→403 sin efectos; `denegada` renderiza el errorCode. Hecho cuando: vitest verde.

**H5 — Wiring + documentación.** Territorio: `server/serve-rls.ts`, `docs/gestion-de-dominio.md` (sección «Publicar el job de un proceso»), `docs/frescura-oferta-demanda.md` (párrafo del eslabón create→observar). Hecho cuando: typecheck + test + `npm run build` verdes; la doc explica el corte instancia/Producto de §4.

---

## 7 · Destranque

**Evento habilitante:** comentario en #107 con el veredicto **positivo** del hito cero (matriz + crudos) **y** las decisiones de César sobre D8/D9/D12.

**Qué envejece mientras tanto — y se re-verifica al destrabar:**

1. **Las formas de la API de autoría** (§3, tabla): endpoints, semántica LRO, nombres de parte (`SparkJobDefinitionV1.json`, `pipeline-content.json`), soporte de SP por tipo de item. **La sonda de H0 es también el instrumento de re-verificación**: si entre la medición y la construcción pasan semanas, se re-corre antes de arrancar H1.
2. **La taxonomía de errorCodes** de Fabric (base de `AuthoringDenied` y de la matriz): puede mutar sin aviso.
3. **Los permisos del tenant**: un veredicto positivo puede revocarse por cambio de tenant setting o de rol del SP entre medición y despliegue — re-correr la sonda es barato; asumir que el positivo sigue vigente no lo es.
4. **El cruce con #138 (config recargable, diseño `03-138-2` de este cluster):** si César aprueba esa vía, `VERGIS_JOB_TEMPLATES` nace recargable en caliente en vez de solo-arranque — releer ese diseño al destrabar H2.
5. **Las superficies de fase 1** (`/admin/sources`, arnés de tests, `GovernanceStore`): otros frentes del backlog las tocan; los territorios de H3/H4 se re-anclan contra `main` al destrabar.
6. **El reparto abierto/no-abierto de #113 (diseño `11-113`):** puede mover el corte de módulos de `packages/capabilities` — los paths de H1–H3 son sensibles a ese re-corte.

---

## 8 · Riesgos y no-metas

**Riesgos:**

- **Radio de daño del poder de autoría** — quien pueda reescribir la definición de un job puede hacer ejecutar otro código en el motor. Mitigaciones de diseño: solo plantillas de la instancia (no hay editor libre de definiciones), render D11 (parámetros no inyectan estructura), credencial separable (D9), no-delete (D8), audit + ledger de todo intento.
- **Drift silencioso** si la instancia edita el item en Fabric: mitigado con detección y declaración en el plan (D6) — riesgo residual: entre plan y exec puede editarse; el hash del plan cubre el lado Vergis, el read-back (D7) evidencia el resultado final real.
- **LRO indeterminado**: cubierto con `desconocida` + re-verificación (D7); riesgo residual: un item creado cuyo create se reportó `desconocida` puede quedar huérfano en el motor — visible porque el plan siguiente lo detecta por nombre (conflicto) y la fila `desconocida` queda en el ledger esperando resolución.
- **La sonda deja residuo** si su limpieza falla: acotado por el prefijo `vergis_probe_` y el reporte explícito (§3, paso E).

**No-metas de la fase 2:**

- Autorar o desplegar **código** del convertidor (terreno instancia — D2).
- Borrar items del motor (D8) o gestionarle workspaces, lakehouses o capacidades.
- Editor visual/in-app de plantillas o pipelines (las plantillas se versionan en el repo de la instancia — D3).
- Publicación por stewards (el corte de rol es de plataforma — D4).
- Integración Git de Fabric o deployment pipelines del motor (solo entran como rediseño si el hito cero da negativo estructural — §3).

---
• 🤖 Claude (Fable) · diseño del frente #107 fase 2 · cluster 004
