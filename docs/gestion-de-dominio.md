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

- **Fuentes** = *conectar* una fuente y declarar su **oferta** (cada cuánto se actualiza). Es un acto
  **técnico** (credenciales, endpoint, item del motor que la ingesta) → **Gestión de Plataforma**. Cada
  fuente lleva su `domain` (tag), pero el **registro/conexión** se administra de forma central.
- **Frescura** = ¿la **entidad** que mi dominio sirve cumple lo que sus PIs demandan? Es el **contrato**
  del dominio con sus consumidores → **Gestión de Dominio**, por dominio. Ancla en la **entidad** (tabla
  de salida silver), no en la conexión.

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

### Disparo (por slot)
- **land-only** — Mira deja el crudo; el pipeline lo toma en su próxima corrida.
- **land-and-trigger** — tras subir, Mira hace **run-now** del pipeline (inmediatez).

### Gobierno
Gateada por **rol de dominio** (steward/admin), **validada** (patrón de nombre + tamaño), **auditada**
(quién subió qué archivo, a qué slot, cuándo, si disparó). Es un write-path **de archivos**, análogo al
de data maestra. El write a OneLake y el run-now usan **token AAD por Service Principal** (recursos
NO-SQL; la auth de SQL va por `mssql`).

## 5 · El espacio completo de gestión de dominio

Un dominio posee su producto de datos de punta a punta. Las facetas (✅ vivas / 🔭 previstas):

- **Entrada:** Ingesta ✅ · Mapa de identidad del dominio 🔭. *(El registro/conexión de fuentes es de
  **plataforma** — ver el corte arriba; el dominio sólo lee la oferta de sus fuentes.)*
- **Dato y modelo:** Data Maestra ✅ · Catálogo/diccionario 🔭 · Linaje 🔭 · Calidad de datos 🔭.
- **Gobierno del dato:** Política RLS del dominio 🔭 (la mitad de Custos que es del dominio) · Stewards ✅.
- **Productos:** Catálogo de PIs del dominio 🔭 (*el interior* de un PI es per-PI, no dominio).
- **Observación:** **Frescura por entidad** ✅ (brecha demanda↔oferta · corridas · schedule deseado/real ·
  salud failed/missed). La cadencia se **deriva** y se **empuja** al motor por proceso (reconciliador).

El área de dominio muestra las facetas vivas y un roadmap visible («Próximamente») de las 🔭.

## 6 · Para agentes — el contrato

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

## 7 · Estado de implementación

| Pieza | Estado |
|-------|--------|
| Modelo de dos clases de gestión + concepto Dominio (tag) + autz | ✅ (`domain.ts`) |
| Gate `/admin` = admin O steward · dashboard de salud · área de dominio | ✅ (`server/admin.ts`) |
| Ingesta: contrato de slots + validación | ✅ (`intake.ts`) |
| Ingesta: write a OneLake (DFS) + run-now Fabric + token AAD por SP | ✅ (`intake-onelake.ts`, `aad-token.ts`) |
| Parser multipart (subida de archivo) | ✅ (`server/multipart.ts`) |
| Frescura por entidad + salud en vivo (run-history) + schedule + «aplicar cadencia» | ✅ (`admin.ts` · faceta Frescura del dominio; `fabric-engine.ts`) |
| Fuentes (registro técnico) en Gestión de Plataforma | ✅ (`admin.ts` · `/admin/sources`) |
| Facetas 🔭 (catálogo, linaje, calidad, RLS de dominio, identidad, PIs) | previstas (roadmap visible) |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/041`. GH es **contra qué se prueba**,
> no el molde: esta capacidad es genérica.
