# 05 · Diseño #111 — el catálogo de convenciones de plataforma como tercera rúbrica de Miranda

**Frente:** #111 — «miranda: cablear el catálogo de convenciones de plataforma como tercera rúbrica»
**Horizonte:** diferido (disparador: ≥2 casos aplicados) · diseño **previsor**: el día del destranque debe ser un cableado, no un proyecto.
**Origen:** instancia GH (Grupo Hijuelas), pendiente `P-105` (el pendiente vive en la instancia; `grep -rn "P-105"` sobre este repo no lo encuentra — verificado).

---

## 1 · Estado actual verificado

- **`MIRANDA_RUBRIC_DIR` monta hoy exactamente dos archivos**, con destinos distintos:
  - `dsl.md` → al **system prompt principal** de Miranda vía `buildSystemPrompt({ dslDoc })` — `server/serve-rls.ts:1462-1465`.
  - `qc1.md` → al **juez del self-check** (QC①), no al prompt principal: viaja como `deps.rubric` (`server/serve-rls.ts:1478`) y lo consume `buildJudgeSystem` (`packages/miranda/src/self-check.ts:70-71,105`).
- **`buildSystemPrompt`** vive en `packages/miranda/src/prompt.ts:67-75`. Ensambla en orden: `IDENTITY` + `MIRANDA_HARD_RULES` + bloque DSL (si hay) + `ELICITATION` + `INTENT_FORMAT` + `extra` opcional (`prompt.ts:59-64`). El patrón de la casa: **las reglas duras van en una constante de código** (`MIRANDA_HARD_RULES`, `prompt.ts:10-23`) espejadas por gates, no solo en archivos de instancia.
- **El system prompt se ensambla una vez al arranque y se cachea**: `systemWithCacheBreakpoint` marca `cache_control: {type:'ephemeral'}` sobre el prefijo estable (`packages/miranda/src/agent.ts:74-85, 120`). El comentario del código lo dimensiona en «~60k tokens» (`agent.ts:74` — cifra del comentario, no re-medida aquí).
- **Los ejemplares de `dsl.md`/`qc1.md` NO viven en este repo** (`find` sobre el árbol: cero resultados — verificado). La instancia decide la versión (`serve-rls.ts:1454`). Dónde viven exactamente los ejemplares de la instancia GH: **conjetura** — presumiblemente en el terreno de la instancia; se confirma al destrabar (vía skill `mira-ops`).
- **La config**: `MIRANDA_RUBRIC_DIR` entra por `server/config.ts:106,349` y está documentada en `docs/miranda.md:52`.
- **Convenciones de plataforma reales ya documentadas como tales** en `docs/catalogo-elementos.md`:
  - Rótulos de valor sobre las barras: «convención de plataforma, no un opcional del spec» (`catalogo-elementos.md:86-96`).
  - Tema y color de charts «no declarable por spec»: «el spec dice QUÉ se grafica, la plataforma decide CÓMO se ve»; todo PI nace con fondo blanco, la instancia revierte con `VERGIS_THEME_*` (`catalogo-elementos.md:137-147`).
  - Orden del eje temporal/categorías: el calendario lo conoce el `ORDER BY` del SQL (Gold-in-query); `sort: chrono` respeta el orden de llegada (`catalogo-elementos.md:52-82`, tesis en `:72-74` y `:128-135`).
  - El `dato` «jamás es interactivo» y usa tipografía de texto, no tarjeta KPI (`catalogo-elementos.md:10-11,24-25`).
- **Tests existentes que tocan el prompt**: `tests/miranda-security.test.ts:21-22` (el prompt no filtra tokens `sk-`), `tests/miranda-agent.test.ts:57`. Gates del repo: `npm run typecheck` y `npm test` (vitest) — `package.json:15-16`.
- **El issue #111** (leído con `gh api`): pide el tercer archivo con disparador «cómo suena» + frase canónica; difiere el cableado hasta ≥2 casos aplicados; declara la frontera: **legibilidad es juicio humano** — Miranda puede reconocer que la petición cae en zona gris y decirlo, **no dictaminar**.

## 2 · Decisiones selladas

**D1 — El cableado es un tercer archivo `convenciones.md` en `MIRANDA_RUBRIC_DIR`, montado al system prompt PRINCIPAL (no al juez, no una herramienta de consulta).**
Racional:
- *Contra la herramienta de consulta*: hay un problema de bootstrap — para saber **cuándo** consultar el catálogo, Miranda ya tendría que saber qué peticiones huelen a convención chocada; ese conocimiento ES el catálogo. La clasificación debe ocurrir en el instante de la petición, sin acto deliberado previo. Además una tool agrega un turno de tool-use y latencia por consulta, y no aporta frescura: los archivos de `RUBRIC_DIR` se leen una vez al arranque igual (`serve-rls.ts:1462-1464`), así que «actualizar sin redeploy» no lo daría ninguna de las dos vías.
- *Tokens*: el catálogo pesa ~1-2k tokens (Anexo A completo: ~900 palabras) contra un prompt ya de ~60k según `agent.ts:74`; y como el system prompt es prefijo cacheado (`agent.ts:83-85`), el costo marginal por turno después del primero es ≈0. El costo real es una vez por arranque de caché — despreciable.
- *Actualización*: reemplazar el archivo en la instancia + restart — exactamente el camino operativo que ya tiene `dsl.md` («la instancia decide la versión», `serve-rls.ts:1454`). Cero mecanismo nuevo.
- *No al juez QC①*: el choque de convención ocurre en **elicitación** (la petición del usuario), no en la revisión del draft. Un draft que violara una convención dura (p. ej. declarar colores) ya lo rechaza la validación del DSL por campo desconocido — el juez no necesita el catálogo. *(La afirmación «lo rechaza la validación del DSL» es conjetura razonable — no se corrió el validador contra un spec con campo de color; verificarla es parte del checklist de destranque.)*

**D2 — El montaje técnico es un campo dedicado `conventionsDoc` en `SystemPromptOptions`, no el `extra` existente.**
`extra` (`prompt.ts:62-63`) es texto libre de instancia sin marco; el catálogo necesita un **framing fijo del Producto** que lo presente y cargue la regla de zona gris (D4). El framing vive como constante de código (`CONVENTIONS_FRAMING`) siguiendo el patrón de la casa (`MIRANDA_HARD_RULES` en código, `prompt.ts:10`): así la prohibición de dictaminar queda **versionada con el Producto e inmune a ediciones del archivo de instancia**.

**D3 — Formato del catálogo: entradas `C-NN` con seis campos fijos, en Markdown legible; el ledger de casos vive DENTRO de cada entrada.**
El esquema exacto está en §3.1 y el ejemplar completo v1.0 en el Anexo A. Markdown y no YAML/JSON: lo leen tres audiencias (Miranda en el prompt, el humano que responde un choque a mano pre-cableado, y el operador que registra casos), y el único consumo mecánico —medir el disparador ≥2— se resuelve con un `grep` sobre una forma de línea fija (§3.4). Un formato estructurado agregaría un parser sin agregar una capacidad.

**D4 — La frontera de legibilidad se codifica en tres capas, y se declara honestamente que NO hay gate de código posible.**
(a) La entrada de legibilidad existe **dentro del catálogo** con `zona: gris` y una respuesta canónica que reconoce sin resolver (Anexo A, C-04). (b) El `CONVENTIONS_FRAMING` de código (D2) carga la regla general: *toda entrada `zona: gris` se reconoce y se declara; jamás se dictamina ni se auto-resuelve*. (c) El esquema mismo obliga el campo `zona` en cada entrada, así la distinción sobrevive a quien agregue convenciones después. No hay cuarto nivel: la prohibición gobierna **lo que Miranda dice**, no una transición de estado del store, y los gates de código de Miranda viven sobre transiciones (`docs/miranda.md:30-32`) — fingir un gate aquí sería teatro. El espejo en código es el framing, no un guard.

**D5 — `[aprobada por César · 2026-08-08]` La sede canónica del catálogo semilla es `rubric/convenciones.md` en este repo; la instancia lo monta (copia) a su `MIRANDA_RUBRIC_DIR`.**
Racional: las convenciones del Anexo A son **del Producto** (todas anclan a `docs/catalogo-elementos.md`), y el disparador de destranque debe medirse con un comando sobre un artefacto versionado — un ledger que vive solo en el terreno de una instancia convierte «≥2 casos» en folclore. `rubric/` nace como sede de semillas montables de rúbrica (a futuro podría acoger ejemplares canónicos de `dsl.md`/`qc1.md` — no-meta hoy). *Alternativa descartada*: que el catálogo nazca directo en la instancia como sus hermanos `dsl.md`/`qc1.md` — descartada porque esos dos son consumo puro (la instancia elige versión y ya), mientras el catálogo es además **el instrumento de medición del destranque** y necesita historia git. César puede revocar la ruta (`rubric/` vs `docs/` vs `deploy/`), no el principio de que viva versionado en el repo.

**D6 — El mecanismo de acumulación pre-cableado: el ledger son líneas `- caso …` dentro de la entrada chocada, con espejo en un comentario del issue #111.**
Quien aplica una convención en la práctica (pre-cableado: César/Claude respondiendo a mano en una instancia; post-cableado: la sesión que observe a Miranda aplicarla) agrega una línea de caso al catálogo del repo **y** comenta el issue con el mismo texto. El repo es la fuente; el comentario es la notificación que hace visible el conteo sin clonar. Formato de línea y comando de medición en §3.4. Registrar el caso es trabajo humano/de sesión también después del cableado — Miranda no escribe su propio ledger (no-meta §6).

## 3 · Arquitectura y contratos

### 3.1 · El esquema de una entrada del catálogo

```markdown
## C-NN · <nombre corto de la convención>

- **Convención:** <la regla en 1-2 líneas> — fuente: `<doc canónico:sección/líneas>`
- **Zona:** normal | gris
- **Cómo suena chocarla:** «<frase típica 1>» · «<frase típica 2>» · «<frase típica 3>»
- **Respuesta canónica:** «<la frase con que se responde, en la voz de Miranda>»
- **Redirige a:** <el rol/pregunta que SÍ le pertenece al usuario, o el canal humano si zona gris>
- **Casos aplicados:**
  - caso 2026-MM-DD · <instancia> · «<cita de cómo sonó>» · <cómo se resolvió> · <enlace/pendiente>
```

Contrato de los campos:

| Campo | Semántica |
|---|---|
| `Convención` | La regla, con **fuente anclada** al doc canónico del Producto. Sin fuente no entra al catálogo (criterio de admisión, §6). |
| `Zona` | `normal`: Miranda clasifica y responde con la frase canónica. `gris`: Miranda **reconoce y declara** que la petición cae ahí, **jamás dictamina** — la resolución es humana. |
| `Cómo suena chocarla` | Disparadores en lenguaje del usuario — el síntoma, no la regla. Es lo que permite clasificar la petición ANTES de tratarla como requerimiento nuevo. |
| `Respuesta canónica` | Una frase completa, lista para decir. Nunca cierra la puerta en seco: siempre termina redirigiendo. |
| `Redirige a` | La pregunta correcta (rol del elemento, formato, corte de datos…) o, en zona gris, el canal humano. |
| `Casos aplicados` | El ledger (§3.4). Nace vacío en v1.0. |

El archivo abre con encabezado versionado (Norma 3, esquema X.Y: `v1.0` al nacer) y una línea de propósito. El ejemplar inicial completo —cuatro entradas: tres `normal` ancladas a convenciones reales + la de legibilidad `gris` exigida por el issue— está en el **Anexo A**, listo para copiar sin redacción adicional el día que se apruebe.

### 3.2 · El cableado (código que se escribe el día del destranque)

**`packages/miranda/src/prompt.ts`** — dos adiciones:

```ts
/** Marco de las convenciones — en código (patrón MIRANDA_HARD_RULES): la regla de
 *  zona gris no depende del archivo de instancia. */
export const CONVENTIONS_FRAMING = `CONVENCIONES DE PLATAFORMA (catálogo montado por la instancia):
Cuando una petición SUENE como uno de los disparadores del catálogo, NO la trates como requerimiento
nuevo ni como brecha: clasifícala como convención chocada, responde con la frase canónica de la entrada
y redirige a la pregunta que sí le pertenece al usuario.
REGLA DE ZONA GRIS (no negociable): las entradas marcadas «zona: gris» son JUICIO HUMANO. Puedes
reconocer que la petición cae ahí y decirlo; JAMÁS dictamines (ni «sí se cumple» ni «no se cumple»)
ni auto-resuelvas modificando el spec para zanjarla. La resolución se levanta al canal humano que la
entrada indica.`
```

- `SystemPromptOptions` gana `conventionsDoc?: string` (junto a `dslDoc`, `prompt.ts:59-64`).
- `buildSystemPrompt` lo inserta **después** del bloque DSL y antes de `ELICITATION`: `parts.push(`${CONVENTIONS_FRAMING}\n\nEL CATÁLOGO:\n${opts.conventionsDoc.trim()}`)` con el mismo guard `trim()` que `dslDoc` (`prompt.ts:69-71`). Ausente el archivo → cero sección, comportamiento actual intacto.

**`server/serve-rls.ts`** — una línea junto a sus hermanos (`:1462-1465`):

```ts
const conventionsDoc = rubricDir ? readIf(join(resolve(rubricDir), 'convenciones.md')) : undefined
const systemPrompt = buildSystemPrompt({ dslDoc, conventionsDoc })
```

**`docs/miranda.md:52`** — la fila `MIRANDA_RUBRIC_DIR` pasa a nombrar los tres archivos.

Sin env nueva, sin ruta nueva, sin tool nueva, sin migración: instancia que no monta el archivo = comportamiento de hoy. El caché del prompt (`agent.ts:83-85`) absorbe el catálogo en el prefijo estable sin cambio alguno.

### 3.3 · La frontera en operación (qué hace Miranda ante cada zona)

| Situación | Conducta contratada |
|---|---|
| Petición suena a entrada `normal` | Clasifica, responde la frase canónica, redirige. NO abre brecha, NO llama `create_data_request`, NO modifica el draft para «cumplir» el pedido chocado. |
| Petición suena a entrada `gris` (legibilidad) | Dice explícitamente que el punto es juicio humano fuera de su cancha, nombra el canal (operador de la plataforma / César), y sigue con lo que SÍ es suyo. No modifica el spec para «arreglar» legibilidad ni afirma que «se lee bien». |
| Petición no suena a nada del catálogo | Flujo normal de elicitación (`prompt.ts:32-42`). El catálogo no introduce falsos rechazos: en la duda, requerimiento. |

### 3.4 · El ledger y el disparador medible

Forma de línea **fija** (dos espacios de sangría, prefijo `- caso `):

```markdown
  - caso 2026-08-21 · GH · «¿pueden poner las barras del color del logo?» · se respondió C-01 y se redirigió a rol del elemento · P-105
```

**Comando de medición del destranque** (el disparador «≥2 casos aplicados» deja de ser folclore):

```bash
grep -c '^  - caso ' rubric/convenciones.md   # destranque cuando ≥ 2
```

Circuito de registro: quien aplica la convención (a) agrega la línea en la entrada correspondiente del catálogo del repo (commit normal), (b) pega la misma línea como comentario en #111. El conteo en el repo manda; el comentario notifica.

## 4 · Plan de construcción

> Hitos elaborados para un Opus en frío. H1 no está gateado por el destranque (el catálogo debe existir ANTES para poder acumular casos); H2-H3 sí.

**H1 — Sembrar el catálogo** *(gate: aprobación de este diseño por César, en particular D5)*
- Territorio: `rubric/convenciones.md` (archivo y directorio nuevos; nada más).
- Acción: copiar el Anexo A literal.
- Hecho cuando: `test -f rubric/convenciones.md && grep -c '^## C-' rubric/convenciones.md` da `4`, y `grep -c '^  - caso ' rubric/convenciones.md` da `0`.
- Juez: los dos comandos + `npm run typecheck && npm test` verdes (no tocan código: deben quedar exactamente como estaban).

**H2 — Cablear** *(gate: destranque §5)*
- Territorio: `packages/miranda/src/prompt.ts`, `packages/miranda/src/index.ts` (export de `CONVENTIONS_FRAMING`), `server/serve-rls.ts`, `docs/miranda.md`, `tests/miranda-prompt-convenciones.test.ts` (nuevo).
- Acción: exactamente §3.2. Test nuevo con tres casos: (1) `buildSystemPrompt({ conventionsDoc: 'X' })` contiene `CONVENTIONS_FRAMING` y `X`; (2) el framing contiene la prohibición de zona gris (asserts sobre «JAMÁS dictamines» y «zona: gris»); (3) sin `conventionsDoc`, el prompt no contiene el framing (paridad byte a byte con el prompt actual).
- Hecho cuando: `npm run typecheck && npm test` verdes con el test nuevo incluido.
- Juez: gates del repo (sin enmascarar exit codes con pipes).

**H3 — Montar en la instancia** *(gate: H2 desplegado; ejecuta el operador con la skill `mira-ops`)*
- Territorio: `MIRANDA_RUBRIC_DIR` de la instancia (fuera de este repo) — copiar `rubric/convenciones.md` junto a `dsl.md`/`qc1.md` + restart del servicio por el flujo versionado (Ley W. Norma 5: nada de edición manual suelta en producción).
- Hecho cuando: una sesión de Miranda, ante la frase disparadora de C-01 («¿pueden poner el gráfico con los colores del logo?»), clasifica el choque y responde en la línea de la frase canónica en vez de intentar especificar colores.
- Juez: la transcripción de esa sesión de prueba, adjunta como comentario de cierre en #111.

## 5 · Destranque

**Evento habilitante:** `grep -c '^  - caso ' rubric/convenciones.md` ≥ 2 — dos casos aplicados registrados por el circuito §3.4. (Si H1 aún no corrió, los casos se acumulan como comentarios en #111 con la misma forma de línea y el conteo se hace ahí; H1 los incorpora al sembrar.)

**Qué re-verificar al destrabar** (partes del diseño sensibles a envejecer):

1. **Anclas de código**: `serve-rls.ts:1462-1465`, `prompt.ts:59-75`, `agent.ts:74-85`, `self-check.ts:70-71` — números de línea y shapes pueden haberse movido; re-localizar antes de editar. Si `buildSystemPrompt` cambió de firma o el bloque MIRANDA se movió de archivo, §3.2 se re-mapea (la decisión D1/D2 sobrevive; el diff no).
2. **El contenido de las entradas** contra `docs/catalogo-elementos.md`: si la convención de tema/rótulos/orden cambió, el Anexo A se corrige ANTES de montar (la fuente manda sobre el catálogo).
3. **Los ≥2 casos reales**: leerlos y ajustar los disparadores «cómo suena» con las frases que de verdad se dijeron — para eso se difirió; sembrar v1.1 del catálogo con esa evidencia es el punto entero del issue.
4. **La conjetura de D1** («un spec con campos de color lo rechaza el validador del DSL»): correr el validador con un draft que declare estética y confirmar; si NO lo rechaza, evaluar si el juez QC① necesita también el catálogo (hoy: no-meta).
5. **Presupuesto de prompt**: confirmar que el system sigue bajo caché con breakpoint y que el catálogo (que habrá crecido con casos) no engordó de ~2k tokens; si el ledger lo infla, los casos se mudan a un archivo hermano no montado (`convenciones-casos.md`) y el catálogo montado queda solo con reglas — decisión diferida a ese momento.
6. **Dónde viven los ejemplares de rúbrica de la instancia GH** (conjetura de §1): confirmar con `mira-ops` el camino real de montaje para H3.

## 6 · Riesgos y no-metas

**Riesgos**
- *El catálogo como basurero*: sin criterio de admisión, cada preferencia se vuelve «convención». Mitigación contratada: no entra una entrada sin fuente anclada a un doc canónico del Producto **o** sin caso real registrado — el campo `Convención` lo exige por esquema.
- *Divergencia catálogo ↔ docs*: la fuente anclada por entrada hace la deriva detectable (checklist de destranque §5.2), pero no la impide; el catálogo declara en su encabezado que ante conflicto **manda el doc canónico**.
- *Falso positivo de clasificación* (Miranda ve convención chocada donde hay requerimiento legítimo): mitigado por contrato §3.3 —en la duda, requerimiento— y porque toda frase canónica redirige a una pregunta en vez de cerrar; el daño residual es una frase de más, no un requerimiento perdido.
- *Framing (código) y catálogo (instancia) desincronizados*: el framing solo carga reglas invariantes (qué hacer con una entrada, la regla de zona gris); todo lo que cambia con el uso vive en el archivo. Esa partición es deliberada (D2).

**No-metas**
- Ninguna herramienta de consulta ni env nueva (D1: el cableado es un archivo).
- Ningún gate de código para legibilidad (D4: sería teatro; el enforcement real es framing + entrada + esquema).
- El juez QC① no recibe el catálogo (D1; reevaluable solo si cae la conjetura §5.4).
- Miranda no escribe su propio ledger de casos (el registro es humano/de sesión, §3.4).
- No se tocan `dsl.md`/`qc1.md` ni su semántica de montaje.
- No se cablea nada en esta sesión ni antes del evento de §5 (H1 —sembrar el archivo— es lo único pre-destranque, y espera el OK de César sobre D5).

---

## Anexo A · `rubric/convenciones.md` v1.0 — ejemplar completo listo para sembrar

```markdown
# Convenciones de plataforma — catálogo para Miranda

**Versión:** 1.0 · **Estado:** acumulando casos (sin cablear — issue #111)
Cada entrada: cómo SUENA chocar la convención sin saber que existe, y la frase canónica de respuesta.
Ante conflicto entre una entrada y el doc canónico que cita, manda el doc canónico.
No entra una entrada sin fuente canónica del Producto o caso real registrado.

## C-01 · Estética de charts: el spec dice QUÉ, la plataforma decide CÓMO se ve

- **Convención:** el fondo y la paleta son convención de plataforma, no algo que un PI declare;
  todo PI nace con fondo blanco y la identidad visual se decide por instancia (`VERGIS_THEME_*`),
  jamás por spec — fuente: `docs/catalogo-elementos.md` §4.
- **Zona:** normal
- **Cómo suena chocarla:** «¿pueden poner el gráfico en los colores de la empresa?» ·
  «quiero este reporte con fondo oscuro» · «cámbiale el color a las barras».
- **Respuesta canónica:** «El color y el fondo son convención de la plataforma: el spec dice QUÉ se
  grafica y la plataforma decide CÓMO se ve, para que todos los PI se lean igual. Lo que sí me ayuda:
  ¿qué rol cumple este elemento — una medida, una comparación, una alerta?»
- **Redirige a:** el rol del elemento (kpi/dato/semaforo/comparación). Si el pedido es identidad
  visual de TODA la instancia, es decisión de instancia (`VERGIS_THEME_REPORT`/`_DASHBOARD`) y se
  levanta al operador — no cabe en un PI.
- **Casos aplicados:**

## C-02 · Rótulos de valor sobre las barras: siempre presentes

- **Convención:** cada barra (y sub-barra) lleva su valor rotulado; es convención de plataforma, no
  un opcional del spec — un gráfico sin cifra obliga a estimar contra el eje y no imprime bien —
  fuente: `docs/catalogo-elementos.md` §«Rótulos de valor sobre las marcas».
- **Zona:** normal
- **Cómo suena chocarla:** «quítale los numeritos a las barras» · «se ve muy cargado con tantas
  cifras» · «¿pueden dejar el gráfico limpio, solo las barras?»
- **Respuesta canónica:** «Los rótulos de valor son convención de la plataforma: sin la cifra, leer
  el gráfico obliga a estimar contra el eje, y el reporte impreso pierde el dato. Si el problema es
  la densidad, la palanca es otra: menos categorías o un corte distinto.»
- **Redirige a:** si molesta el formato del número → `format` del elemento (p. ej. `abbr`); si
  molesta la densidad → el corte de datos (top-N, otra dimensión) — eso sí es del spec.
- **Casos aplicados:**

## C-03 · El orden de las categorías lo manda la query, no el motor

- **Convención:** el motor no parsea fechas ni meses: el calendario lo conoce el `ORDER BY` del SQL
  (Gold-in-query); `sort: chrono` respeta el orden de llegada de las filas — fuente:
  `docs/catalogo-elementos.md` §`sort` y §3 (`series`).
- **Zona:** normal
- **Cómo suena chocarla:** «los meses salen desordenados, ordénalos de enero a diciembre» ·
  «¿por qué el gráfico ordena de mayor a menor si esto es una serie en el tiempo?»
- **Respuesta canónica:** «El orden calendario lo pone la consulta, que es quien conoce el dato: yo
  declaro `sort: chrono` y la fuente entrega los meses ya ordenados. No hay un parser de meses en el
  motor — y eso es a propósito.»
- **Redirige a:** la definición de la medida/fuente (que el orden quede en la query) — eso sí se
  especifica en el PI.
- **Casos aplicados:**

## C-04 · Legibilidad — ZONA GRIS: juicio humano

- **Convención:** «que se lea bien» (tamaño percibido, apretujamiento, comprensibilidad de un
  gráfico) no tiene regla mecánica: es juicio humano y NO se auto-resuelve — fuente: issue #111
  (frontera declarada; origen P-105, instancia GH).
- **Zona:** gris
- **Cómo suena chocarla:** «no se lee» · «la letra quedó muy chica» · «este gráfico no se entiende».
- **Respuesta canónica:** «Ese punto cae en zona gris: la legibilidad es un juicio humano y no me
  corresponde zanjarlo — ni afirmarte que se lee bien ni cambiar el spec para “arreglarlo”. Lo dejo
  planteado para el operador de la plataforma, y sigamos con lo que sí puedo resolver contigo.»
- **Redirige a:** el operador de la plataforma / César (canal humano). Miranda NO modifica el draft
  para zanjar legibilidad ni emite veredicto en ningún sentido.
- **Casos aplicados:**
```

---
• 🤖 Claude (Fable) · diseño del frente #111 · cluster 004
