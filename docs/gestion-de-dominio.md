# Gestión de Dominio (y de Plataforma) — cómo se organiza la Administración de Mira

> **Documentación canónica del Producto.** Define cómo el ambiente de Administración de Mira/Vergis
> separa **gestión de plataforma** de **gestión de dominio**, y cómo se ofrece la **ingesta de
> archivos** dentro de la gestión de dominio. Comportamiento **genérico**, independiente de instancia.
> Complementa [`gobierno-permisos.md`](gobierno-permisos.md),
> [`data-maestra-y-publicacion.md`](data-maestra-y-publicacion.md) y
> [`frescura-oferta-demanda.md`](frescura-oferta-demanda.md).

## 1 · Dos clases de gestión

El ambiente de Administración distingue, por **naturaleza** de lo gestionado, dos clases:

| | **Gestión de Plataforma** | **Gestión de Dominio** |
|---|---|---|
| Gobierna | la plataforma misma, transversal | un **dominio de datos** concreto |
| Incluye | Usuarios y Roles · Grupos de Mira · **Fuentes** · Settings | Data Maestra · **Frescura** (por entidad, incl. la **carga manual de archivos**) |
| Quién | **admins** de plataforma | **stewards** del dominio (+ admin como override) |
| Presentación | **una sola** entrada (`/admin/plataforma`) que adentro despliega todo | **un área por dominio** (`/admin/dominio/<id>`) |

Es la forma operable del principio **ownership-por-dominio** (data-mesh): la plataforma ofrece gobierno
transversal, pero **cada dominio se gestiona como dominio**. La mayoría de lo que parece "administración
general" (la data maestra de un dominio, su **frescura**) es en realidad **de dominio**; lo transversal
es acceso (roles/grupos), **la conexión técnica de fuentes** y settings.

### Fuentes (plataforma) vs Frescura (dominio) — un corte deliberado

Son **dos cosas distintas** y por eso viven en clases de gestión distintas:

- **Fuentes** = *conectar* una fuente y declarar su **oferta** (cada cuánto se actualiza), **dar de alta
  procesos** que apuntan a un item del motor —ya existente, o **publicado desde acá** (§5)— y declarar
  sus salidas y mapeos. Es un
  acto **técnico** (credenciales, endpoint, item del motor que la ingesta) → **Gestión de Plataforma**,
  y se hace **in-app**, sin editar el yaml de la VM ni reiniciar. Cada fuente lleva su `domain` (tag),
  pero el **registro/conexión** se administra de forma central.
- **Frescura** = ¿la **entidad** que mi dominio sirve cumple lo que sus PIs demandan? Es el **contrato**
  del dominio con sus consumidores → **Gestión de Dominio**, por dominio. Ancla en la **entidad** (tabla
  de salida silver), no en la conexión. Acá el steward **aplica la cadencia** y **pausa/reanuda** el
  proceso: pausar deshabilita su schedule en el motor y el lazo automático respeta esa pausa (no alerta
  ni le corrige el schedule), sin dejar de observarlo.

**Semilla y runtime.** `sources.yaml` (`VERGIS_SOURCES`) sigue siendo el bootstrap declarativo del
registro, pero **lo gestionado in-app gana**: una fila editada desde la plataforma no la pisa la
re-siembra de arranque, y una fila dada de baja no resucita. Una instancia que solo gestiona por yaml
no cambia en nada.

La "frescura de insumos" (bronze) **no es un concepto aparte**: es la **oferta de la fuente**, que ya
vive en Fuentes. La Frescura del dominio lee esa oferta y la confronta con la demanda. Las corridas de
ingestión aparecen como **linaje debajo de cada entidad** (qué corrida produjo su frescura actual).

> **Entidad = unidad de demanda; proceso = unidad de schedule.** Una entidad hereda la cadencia del
> proceso que la produce; el schedule del proceso = mín de las cadencias requeridas de sus entidades.
> La vista es **por entidad**; el push del schedule al motor es **por proceso** (roll-up).

## 2 · Dominio — concepto liviano, tag-based

Un **dominio** es un área de datos del negocio (Personas, Cartera/Finanzas, Comercial…). Para no
mantener un registro central que driftee:

- **Cada artefacto declara su dominio** con un campo `domain: <id>` — entidades de data maestra, slots
  de ingesta, fuentes. La **composición** del dominio se **deriva** de los artefactos que lo declaran.
- Un `domains.yaml` de instancia aporta solo lo que no se infiere: **etiqueta legible** + **stewards**
  (quién lo gestiona). El dominio es un objeto real para **autorizar y agrupar**.

### Autorización
- **`canManageDomain(dominio, email, isAdmin)` = admin O steward declarado.** Stewards = correos en
  el dominio **o** miembros de un **default-steward-group** (`VERGIS_DEFAULT_STEWARD_GROUPS`): un grupo
  de Mira cuyos miembros son stewards de **todos** los dominios — simétrico al default-collaborator-group
  de los PIs. Pensado para un equipo transversal (p. ej. el centro de excelencia que construye todo).
- El **gate de `/admin`** es **«admin O steward de algún dominio»** — quien no gestiona nada, no entra.
- Una entidad de data maestra con `domain` se gestiona por el steward de ese dominio (o admin); sin
  `domain`, solo admin.

## 3 · El home = dashboard de salud

`/admin` es un **dashboard** scopeado a lo que el usuario puede ver: los **dominios** que gestiona
(con inventario: # slots de ingesta, # entidades) y —si es admin— la entrada de **Plataforma** y una
tira de **salud de ingestión** (brecha de frescura computable hoy; la salud de corridas en vivo llega
con el cliente de run-history del motor — ver `frescura-oferta-demanda.md`).

## 4 · Ingesta de archivos — el espejo de la publicación

La ingesta vive en la gestión de dominio. Es el **espejo** de la publicación de data maestra: ahí el
dato **sale** (proyección `__replica`), acá el archivo **entra**.

> **La carga manual se pliega en Frescura** (no es una faceta aparte). Subir un archivo es el **gemelo
> manual** del schedule automático: las dos formas producen una corrida fresca de la misma entidad. Por
> eso el acto de cargar vive en la fila de la entidad dentro de Frescura («Alimentar»), junto a «Aplicar
> cadencia». El write-path (staging, slots, validación, land-and-trigger) es idéntico — solo cambió su
> hogar en la UI: de «ver staleness» y «actuar» en un solo lugar. El `slot` casa con la entidad por el
> item del motor (`slot.trigger.processRef === engine_ref.itemId`). Los slots sin entidad registrada
> aparecen en «Otras cargas» (no se pierden).

### Staging, NUNCA directo a las tablas
El usuario sube el archivo a Mira y Mira lo aterriza en **`Files/<...>` de un Lakehouse** = **landing
zone (staging)** — nunca en `Tables/`. El **pipeline de ingestión existente** (notebook/CopyJob) lee de
ahí y produce Bronze→Silver. **Mira intermedia la ingesta, no reemplaza el transform.** Razón: no-bypass
del medallón (el transform debe correr: schema, dedup, gate de calidad, RLS data-anchored), replayable
y auditable, y uniforme para cualquier motor.

### Slots declarativos (instancia)
Cada **slot** = {`id`, `label`, `domain`, `accept` (glob de nombre), `maxBytes`, `target`
(workspace+lakehouse+ruta `Files/...`), `trigger` opcional}. El usuario **elige el slot** y **nunca ve
la ruta**. El `target.path` **debe** empezar en `Files/` (el contrato lo exige; `Tables/` se rechaza).

### Metadata declarada (por slot)
Algunos archivos **no se pueden convertir sin un dato que no viene en su contenido** y que por política
jamás se infiere: a qué empresa se imputa un extracto, qué versión trae un presupuesto. El slot lo
declara en `meta` (`id`, `label`, `type` = `string|number|enum|rut`, `required`) y el valor viaja con el
archivo como **sidecar** `<archivo>.meta.json`, que el pipeline lee. Hay **dos formas** de escribirlo:

- **Formulario** — la UI de carga lo pide y sin él no deja subir (default).
- **Nombre del archivo** (`from_filename`) — cuando la instancia declaró una convención de nombre para
  ese slot. La metadata sigue siendo declarada; cambia dónde la escribe el usuario.

```yaml
meta:
  - id: empresa_rut
    label: "Empresa receptora (RUT)"
    type: rut
    required: true
    from_filename:
      patterns:                            # el primero que calza gana; `{codigo}` captura el token
        - "Listado EasyDoc {codigo}.xlsx"
        - "Listado SAP {codigo}.xlsx"
      catalog: { VH: "96835510-4", … }     # token → valor; sin catálogo, el token ES el valor
      verify_against: RUTRECEPTOR          # columna del extracto que debe coincidir (opcional)
```

Comportamiento: nombre que calza y token en el catálogo ⇒ resuelto sin preguntar · **nombre fuera de la
convención o token fuera del catálogo ⇒ la carga falla explícita**, nombrando qué se esperaba (nunca se
ingiere a medias ni se imputa un default) · la resolución es **por archivo**, así que un lote puede
traer dos empresas y cada archivo lleva su propio sidecar · un slot sin `from_filename` se comporta
exactamente como antes.

`verify_against` es la única compuerta donde el **contenido** puede desmentir la etiqueta del nombre.
La hace cumplir el **convertidor** —el único actor que lee el archivo; Mira no parsea planillas
(ADR-001)—: Vergis la declara y la propaga en el sidecar bajo la llave `verify` (`{campo: columna}`), y
el pipeline rechaza la carga si donde la columna viene informada contradice lo derivado. Así la
convención se declara **una sola vez, en el slot**, en vez de cablearse dentro de cada pipeline.

### Catálogo de la instancia como fuente de opciones (`options_ref`)
Un campo `enum` puede tomar sus opciones de un **catálogo de la instancia** en vez de listarlas inline.
El campo pasa a ser un **dropdown** y el error de tipeo deja de ser posible en vez de ser detectado. El
catálogo se declara en el bloque raíz `catalogs:` del **mismo** archivo de slots (`VERGIS_INTAKE`): mismo
dueño, misma revisión, mismo hot-reload.

```yaml
catalogs:                                    # opcional; ausente = cero catálogos
  - id: empresas_gh
    label: "Empresas del grupo"
    options:                                 # lista no vacía; `value` único dentro del catálogo
      - { value: "96835510-4", label: "Hijuelas S.A." }
      - { value: "77130310-2", label: "Agrícola El Tranque" }
      - "OTRO"                               # string ≡ { value: "OTRO", label: "OTRO" }

slots:
  - id: facturas
    # …
    meta:
      - id: empresa_rut
        label: "Empresa (receptor)"
        type: enum
        required: true
        options_ref: empresas_gh             # en vez de `options`: uno u otro, nunca ambos
```

Comportamiento: el `<select>` muestra `etiqueta · valor` (se elige por nombre y se verifica el dato a la
vista) y **lo que viaja es el `value`** — el `label` es display y jamás llega al sidecar ni al SJD · la
pertenencia se verifica **en el servidor** al subir, así que manipular el HTML no la salta · una
referencia a un catálogo inexistente, un catálogo sin opciones o un `value` duplicado **no arrancan**
(error ruidoso al desplegar; en caliente el hot-reload rechaza el cambio y conserva lo vigente) · un
campo puede combinar `from_filename` con `options_ref`: el valor derivado del nombre también debe estar
en el catálogo, o la carga falla nombrando archivo y catálogo.

> **Riesgo declarado.** Si el nombre está equivocado y la fuente no trae con qué verificar, la
> imputación es incorrecta sin señal. Antes de anclar una **RLS** en un campo derivado del nombre, esa
> decisión debe tomarse mirando esto.

### Disparo (por slot)
- **land-only** — Mira deja el crudo; el pipeline lo toma en su próxima corrida.
- **land-and-trigger** — tras subir, Mira hace **run-now** del pipeline (inmediatez).

### La consola de Cargas: una casilla por vez, cada una con su URL

`/admin/dominio/<dom>/cargas` es la operación completa de las cargas del dominio, y muestra **una
casilla a la vez**. Con más de un slot declarado, una **barra de pestañas** —una por casilla, en el
orden de `slots.yaml`— encabeza la página, y el bloque de abajo (última conversión, log, «Subir
archivos», Actividad, Landing, Procesados) es el de la casilla **activa**; con un solo slot no se
dibuja. La barra hace dos cosas:

- **Es el inventario visible de casillas del dominio.** Un dominio con casillas hermanas —el archivo de
  productos, el de distribuciones, el maestro— las declara todas en pantalla, así que «esta es la
  casilla del dominio» deja de ser una lectura posible de la página.
- **Cada casilla es enlazable:** `…/cargas?slot=<slotId>`. Al usuario se le manda el link de la casilla
  que le toca, no una instrucción de scroll. Sin el parámetro —o con un `slot` que no existe— abre la
  primera declarada, sin error.

El historial vive pegado a **su** casilla (Actividad, Landing y Procesados se filtran por `slot_id`):
la pestaña no lo mueve de ahí, evita que el de una casilla entierre a las otras, y hace que la página
pida datos solo de la casilla que dibuja.

**El desenlace de una carga vuelve a donde el usuario estaba.** El formulario declara su origen y todo
resultado —recibido o rechazado— aterriza en esa pantalla: el rechazo de una carga hecha en Cargas se
pinta en la pestaña de su casilla, y lo que nace en Frescura muere en Frescura.

**El rechazo por patrón nombra la casilla correcta.** Cuando el archivo rechazado **sí** matchea el
`accept` declarado de otra casilla del dominio, el error lo dice y la enlaza («Este archivo va en
*<label>*»); si matchean varias, se listan. Si ninguna, el mensaje queda en el patrón que falló y **no
se ofrece destino**: solo se nombra un slot cuyo patrón declarado matchea el nombre real del archivo —
nunca una heurística de parecido, contenido o tamaño, y nunca un slot sin `accept` (que aceptaría
cualquier cosa).

### Revertir una carga (`revert_delete`)

«Revertir esta carga» deshace, clave por clave, lo que una carga materializó. El **ledger carga→claves
es el layout `_processed/<clave>/<archivo>`** que el convertidor mantiene: Mira lo lee, deriva un plan,
lo muestra para confirmar y recién entonces compensa —reactivando la versión anterior de la clave y
re-corriendo la conversión (last-wins restaura)—. Una clave pisada por una carga posterior **no se
toca**: solo la carga vigente de una clave es reversible en esa clave.

El caso sin versión previa (la carga **introdujo** la clave) exige un DELETE, y el warehouse lo escribe
solo el convertidor. Mira deja en el landing un **manifiesto de reversión** y el convertidor lo ejecuta:

```yaml
- id: saldos_cartera
  revert_delete: true        # la instancia DECLARA que su convertidor cumple el contrato de abajo
```

```json
{ "revert": { "clave": "W28" }, "slot": "saldos_cartera",
  "filename": "saldos VH WK28.xlsx", "by": "steward@gh.cl", "at": "2026-08-06T18:00:00Z" }
```

**Obligación del convertidor**, al inicio de cada corrida, por cada `_revert_<clave>.meta.json` del
landing: DELETE de esa clave en sus tablas, línea de log `[revert] ✔ clave <clave> eliminada: <N> filas`
(familia de `[delta]`/`✔`) y **eliminación del manifiesto**. Sin la declaración `revert_delete`, Mira no
escribe manifiestos y esa clave se reporta como no-compensable **sin tocar nada** (fail-closed: mover el
archivo dejando el dato materializado sería decir «revertida» sobre un warehouse que no cambió).

### Gobierno
Gateada por **rol de dominio** (steward/admin), **validada** (patrón de nombre + tamaño), **auditada**
(quién subió qué archivo, a qué slot, cuándo, si disparó). Es un write-path **de archivos**, análogo al
de data maestra. El write a OneLake y el run-now usan **token AAD por Service Principal** (recursos
NO-SQL; la auth de SQL va por `mssql`).

## 5 · Publicar el job de un proceso

Dar de alta un proceso en Fuentes supone que **ya existe** el item que lo ejecuta en el motor. Publicar
es el eslabón que faltaba antes de esa cadena: crear (o actualizar) **ese item** desde Mira, sin salir
a la consola del motor. Vive en **Gestión de Plataforma** (`/admin/sources`, junto al registro de
fuentes) porque publicar es un acto de plataforma, no de dominio.

### Qué es publicar — y qué NO es

> **Se publica la CÁSCARA del job, jamás el código del convertidor.** El item del motor (un
> SparkJobDefinition, un pipeline) es una **declaración** que *apunta* al código que vive en
> `Files/code/…` del lakehouse de la instancia. Ese código —y el contrato de ingesta, y el QC— es
> terreno de la instancia y su convertidor. **Mira nunca escribe en `Files/code`.**

Es la misma separación de la ingesta (staging vs transform) y del manifiesto de reversión: *Vergis
declara y propaga, el convertidor ejecuta*.

### Las plantillas son de la instancia

La instancia declara sus plantillas en un manifiesto (`VERGIS_JOB_TEMPLATES`) y las **partes** de la
definición —el JSON del item, con placeholders— en archivos junto a él, cuyas rutas se resuelven
relativas al directorio del manifiesto:

```yaml
templates:
  - id: sjd_ingesta_excel
    label: "Ingesta Excel (SJD estándar)"
    version: "1.0"                       # entre comillas: 1.0 sin comillas es el número 1
    itemType: SparkJobDefinition         # jobType de fase 1: sparkjob
    params:
      - { name: main_file,    label: "Script principal (abfss)", required: true }
      - { name: lakehouse_id, label: "Lakehouse por defecto",    required: true }
    parts:
      - { path: SparkJobDefinitionV1.json, file: parts/sjd-ingesta-excel.json }
```

- **Las versiona el repo de la instancia**, con su flujo repo→despliegue. **No hay editor in-app de
  plantillas**: Mira registra `plantilla@versión` en cada publicación, y nada más.
- **Carga fail-closed y fatal al arranque**: manifiesto sin clave raíz, parte inexistente o ilegible,
  parte que no es JSON, placeholder no declarado o parámetro sin placeholder ⇒ **el nodo no levanta**,
  nombrando env + ruta + detalle. Descubrir un manifiesto incoherente al publicar sería tarde.
- Los parámetros se sustituyen **como valores string dentro del JSON ya parseado**, nunca por
  concatenación de texto: un valor con comillas o llaves no puede romper la estructura de la
  definición ni inyectar claves nuevas.
- `VERGIS_JOB_TEMPLATES` es **solo-arranque**: un cambio en las plantillas se aplica al reiniciar (no
  entra en la recarga en caliente de la config de instancia).

### El flujo: dos fases, con el drift a la vista

1. **Plan.** Se elige proceso + plantilla y se completan sus parámetros. Mira renderiza la definición,
   le calcula su **sha canónico**, lee del motor la definición vigente y muestra el plan: **crear vs
   actualizar**, workspace e item destino, `plantilla@versión`, el sha, y —si corresponde— el
   **drift**: *la definición que hoy tiene el motor no es la última que Vergis publicó*. El plan se
   sella con un **hash de todos sus insumos**.
2. **Confirmar.** Si entre el plan y la confirmación cambió cualquier insumo, el hash no calza y **no
   se ejecuta nada**: se responde con el plan fresco para volver a mirarlo.

> **El drift se declara, jamás se auto-corrige.** El motor es terreno donde también opera la
> instancia: que alguien haya editado el item ahí es **información que el humano confirma**, no una
> diferencia que el Producto reconcilie por su cuenta.

### Éxito = read-back, no «el POST devolvió 200»

Una publicación queda **`ok` únicamente** si el `getDefinition` posterior devuelve lo publicado. La
comparación es **canónica y acotada a las partes publicadas**: el motor normaliza el payload al
persistirlo (`""` → `null`, re-serialización) y puede **agregar partes propias** (`.platform`) —
comparar bytes crudos o la definición completa marcaría como sospechosa toda publicación legítima.

Los cuatro desenlaces, todos asentados en un **ledger append-only** (`job_publication`, en el mismo
SQLite de gobierno) y auditados (`jobs-publish`):

| Desenlace | Qué significa | Qué queda |
|---|---|---|
| `ok` | el read-back devolvió la definición publicada | historial + `engine_ref` si fue un create |
| `denegada` | el motor rechazó la autoría | el **`errorCode` crudo** del motor, a la vista |
| `fallida` | error de la escritura, o read-back no equivalente | el mensaje/código, sin `engine_ref` |
| `desconocida` | la operación larga no culminó en la ventana | el `operationId`, y la fila en la cola de **Re-verificar** |

**`desconocida` no es `fallida`.** Queda pendiente con su `operationId` y la acción **«Re-verificar»**
la resuelve **con lo medido**: re-observa el item y agrega una fila nueva con el desenlace real. La
original **jamás se muta** — el ledger es la memoria de lo publicado; el estado vigente del item lo
dice el motor.

**Al culminar un create, el proceso queda con su `engine_ref`** y desde ahí la cadena de fase 1
(observar, agendar, pausar, reconciliar) opera sin más — ver
[`frescura-oferta-demanda.md`](frescura-oferta-demanda.md).

### Quién puede, y qué no hace Mira

- **Solo admins de plataforma.** El steward de dominio recibe **403** en la sección y en todo POST de
  publicación; conserva exactamente lo suyo (pausa/reanudación, cargas). CSRF en toda escritura.
- **Fail-closed en tres capas:** sin plantillas declaradas, sin credencial de autoría resuelta, o sin
  el registro de fuentes escribible ⇒ **la sección no existe y sus rutas no responden** — ni un solo
  form. Una instancia que no declara plantillas no cambia en nada.
- **Mira no borra items del motor.** Dar de baja un proceso deja el item intacto (borrarlo destruiría
  su run-history, que es evidencia operacional, en un terreno compartido con la instancia).
- **Mira no edita plantillas in-app** ni escribe en `Files/code`.

### El corte instancia / Producto

| Instancia / convertidor | Producto (Mira/Vergis) |
|---|---|
| Código del convertidor (`Files/code/…`) y su despliegue | Orquestación de la publicación (render, plan, operación larga, read-back) |
| Plantillas (manifiesto + partes) y su versionado en su repo | Carga y validación de plantillas, ledger, detección de drift |
| Contrato de ingesta (logs `[delta]`/`✖`, `revert_delete`, sidecars) | UI de administración, roles, CSRF, auditoría |
| El motor mismo (workspaces, capacidades, items pre-existentes) | `engine_ref` → cadena de fase 1 (observar/agendar/pausar) |

### Configuración de instancia

| Env | Qué declara |
|---|---|
| `VERGIS_JOB_TEMPLATES` | ruta al manifiesto de plantillas (sus partes se resuelven relativas a él). **Solo-arranque**, fail-closed y fatal. Sin él, la sección no existe |
| `VERGIS_AUTHORING_SP` | *(opcional)* `database_ref` de `VERGIS_CONNECTIONS` con el perfil de credencial para la **autoría** — así el camino de serving no porta un token capaz de reescribir definiciones. Sin él, se usa el mismo SP del intake. **Declarado y no resoluble ⇒ el arranque falla** nombrando env y perfil: config rota, no un default silencioso |

## 6 · El espacio completo de gestión de dominio

Un dominio posee su producto de datos de punta a punta. Las facetas (✅ vivas / 🔭 previstas):

- **Entrada:** Ingesta ✅ · Mapa de identidad del dominio 🔭. *(El registro/conexión de fuentes es de
  **plataforma** — ver el corte arriba; el dominio sólo lee la oferta de sus fuentes.)*
- **Dato y modelo:** Data Maestra ✅ · Catálogo/diccionario 🔭 · Linaje 🔭 · Calidad de datos 🔭.
- **Gobierno del dato:** Política RLS del dominio 🔭 (la mitad de Custos que es del dominio) · Stewards ✅.
- **Productos:** Catálogo de PIs del dominio 🔭 (*el interior* de un PI es per-PI, no dominio).
- **Observación:** **Frescura por entidad** ✅ (brecha demanda↔oferta · corridas · schedule deseado/real ·
  salud failed/missed). La cadencia se **deriva** y se **empuja** al motor por proceso (reconciliador).

El área de dominio muestra las facetas vivas y un roadmap visible («Próximamente») de las 🔭.

## 7 · Para agentes — el contrato

1. **Dos clases de gestión.** Plataforma (transversal, admins) vs dominio (por dominio, stewards). No
   metas en plataforma lo que es de un dominio ni viceversa.
2. **Dominio = tag.** Cada artefacto declara su `domain`; no asumas un registro central. La membresía
   se deriva.
3. **Autz de dominio = admin O steward.** El gate de `/admin` es «admin O steward de algún dominio».
4. **Ingesta = staging, nunca tablas.** El intake aterriza el crudo en `Files/...`; el pipeline
   existente transforma. No escribas `Tables/` desde el intake.
5. **Valida y audita todo write-path de archivos.** Patrón + tamaño; auditá quién/qué/cuándo/disparó.
6. **Verifica la topología.** Dónde aterriza cada slot (workspace/lakehouse/ruta) y qué SP escribe es
   dato de instancia — confírmalo contra la config real antes de actuar.
7. **Publicar = la cáscara del job, nunca el código.** El item del motor apunta al código del
   convertidor (`Files/code/…`); ese terreno es de la instancia. No escribas ahí desde el Producto, no
   borres items del motor y no agregues un editor de plantillas: se versionan en el repo de la
   instancia.
8. **Nada es «publicado» sin read-back.** El `ok` lo da el `getDefinition` posterior comparado
   canónicamente. Sin él, el desenlace es `desconocida` — pendiente, no exitoso.

## 8 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| Modelo de dos clases de gestión + concepto Dominio (tag) + autz | ✅ (`domain.ts`) |
| Gate `/admin` = admin O steward · dashboard de salud · área de dominio | ✅ (`server/admin.ts`) |
| Ingesta: contrato de slots + validación | ✅ (`intake.ts`) |
| Ingesta: write a OneLake (DFS) + run-now Fabric + token AAD por SP | ✅ (`intake-onelake.ts`, `aad-token.ts`) |
| Parser multipart (subida de archivo) | ✅ (`server/multipart.ts`) |
| Frescura por entidad + salud en vivo (run-history) + schedule + «aplicar cadencia» | ✅ (`admin.ts` · faceta Frescura del dominio; `fabric-engine.ts`) |
| Fuentes (registro técnico) en Gestión de Plataforma | ✅ (`admin.ts` · `/admin/sources`) |
| Registro editable in-app (fuentes, procesos, salidas, mapeos) con precedencia sobre la semilla | ✅ (`admin.ts` · `governance-store.ts`) |
| Pausar/reanudar un proceso desde Frescura (steward) | ✅ (`admin.ts` · `serve-rls.ts` · `fabric-engine.ts`) |
| Publicar el job de un proceso: plantillas de instancia + render | ✅ (`job-templates.ts` · `instance-config.ts` · `VERGIS_JOB_TEMPLATES`) |
| Publicar: cliente de autoría del motor (crear/leer/actualizar definición, operación larga) | ✅ (`fabric-authoring.ts`; credencial separable con `VERGIS_AUTHORING_SP`) |
| Publicar: plan sellado por hash + drift + ledger append-only + read-back canónico + «Re-verificar» | ✅ (`job-publication.ts` · `definition-canonical.ts` · `admin.ts` · `/admin/sources`) |
| Facetas 🔭 (catálogo, linaje, calidad, RLS de dominio, identidad, PIs) | previstas (roadmap visible) |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/041`. GH es **contra qué se prueba**,
> no el molde: esta capacidad es genérica.
