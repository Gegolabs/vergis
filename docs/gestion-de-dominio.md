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
| Incluye | Usuarios y Roles · Grupos de Mira · Settings | **Ingesta de archivos** · Data Maestra · Fuentes & Frescura |
| Quién | **admins** de plataforma | **stewards** del dominio (+ admin como override) |
| Presentación | **una sola** entrada (`/admin/plataforma`) que adentro despliega todo | **un área por dominio** (`/admin/dominio/<id>`) |

Es la forma operable del principio **ownership-por-dominio** (data-mesh): la plataforma ofrece gobierno
transversal, pero **cada dominio se gestiona como dominio**. La mayoría de lo que parece "administración
general" (la data maestra de un dominio, sus fuentes, su frescura) es en realidad **de dominio**; lo
verdaderamente transversal es solo acceso (roles/grupos) y settings.

## 2 · Dominio — concepto liviano, tag-based

Un **dominio** es un área de datos del negocio (Personas, Cartera/Finanzas, Comercial…). Para no
mantener un registro central que driftee:

- **Cada artefacto declara su dominio** con un campo `domain: <id>` — entidades de data maestra, slots
  de ingesta, fuentes. La **composición** del dominio se **deriva** de los artefactos que lo declaran.
- Un `domains.yaml` de instancia aporta solo lo que no se infiere: **etiqueta legible** + **stewards**
  (quién lo gestiona). El dominio es un objeto real para **autorizar y agrupar**.

### Autorización
- **`canManageDomain(dominio, email, isAdmin)` = admin O steward declarado.** Stewards = correos
  (grupos de Mira como stewards = extensión futura).
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

- **Entrada:** Ingesta ✅ · Registro de fuentes (oferta) ✅ · Mapa de identidad del dominio 🔭.
- **Dato y modelo:** Data Maestra ✅ · Catálogo/diccionario 🔭 · Linaje 🔭 · Calidad de datos 🔭.
- **Gobierno del dato:** Política RLS del dominio 🔭 (la mitad de Custos que es del dominio) · Stewards ✅.
- **Productos:** Catálogo de PIs del dominio 🔭 (*el interior* de un PI es per-PI, no dominio).
- **Observación:** Observabilidad de ingestión ✅ lógica · Frescura ✅ · Cadencia/reconciliador ✅ lógica.

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
| Salud de ingestión en vivo (run-history del motor) | 🔧 seam listo; impl HTTP pendiente |
| Facetas 🔭 (catálogo, linaje, calidad, RLS de dominio, identidad, PIs) | previstas (roadmap visible) |

> Instancia de referencia (beta): Grupo Hijuelas — `arbol-lab/work/041`. GH es **contra qué se prueba**,
> no el molde: esta capacidad es genérica.
