# Miranda — el agente que autora specs de PI

> **Documentación canónica del Producto.** Define *cómo funciona* Miranda — la capacidad conversacional
> donde el usuario pide en lenguaje natural y **Miranda** escribe la especificación (el DSL de Mira).
> Es comportamiento **genérico** del Producto (Vergis): la instancia aporta catálogo, rúbrica y usuarios.
> «Mira sirve, Miranda conversa.»

**Versión:** 0.1 (Fase 1 · especificador asistido)
**Estado:** tras `MIRANDA_ENABLED` (default off)

---

## ¿Qué es?

Una superficie de chat (`/miranda`) en la que el especificador conversa y Miranda **elicita → compila el
DSL → se auto-chequea (QC① interno) → previsualiza con RLS → publica**. El usuario vive en *espacio de
intención* (pide, aclara, valida un **resumen de intención**); Miranda vive en *espacio de spec*. El
usuario **nunca toca el YAML**.

El spec no desaparece — cambia de autor: sigue siendo el contrato ejecutable, gobernado, reconciliable
y auditable de la plataforma; ahora lo escribe Miranda. Cada PI nacido por chat queda con **procedencia
completa** (transcript + resúmenes + drafts versionados + qc_reports) en el store de sesiones.

## ¿Por qué es seguro por construcción?

- **Spec authz-blind + autorización data-anchored (Custos).** Miranda jamás escribe autorización en el
  spec; la RLS filtra las filas aguas abajo. Un agente que autora specs no puede abrir un hueco.
- **Un solo riel de serving, siempre con RLS.** La **preview** de un draft se sirve por el MISMO
  `serve-rls` que un PI real, con la identidad del request. No hay canal lateral al dato crudo.
- **Gates en código, no solo en el prompt:** el store rechaza transiciones de estado ilegales; la
  guardia SQL bloquea todo lo que no sea un `SELECT` acotado; `publish` exige `autochequeado` + un
  `qc_report` sin brechas B/M + un draft que valida contra el DSL.

## ¿Máquina de estados de una sesión?

```
explorando → borrador → validado → autochequeado → publicado   (+ descartado desde cualquiera)
```

- `borrador`: hay al menos un draft y/o un resumen de intención.
- `validado`: el usuario aprobó el resumen de intención vigente. Si el resumen cambia, regresa a `borrador`.
- `autochequeado`: el self-check corrió sin brechas B/M.
- `publicado`: se escribió el YAML al directorio de specs (código `PI-NNN`, serie 101+).

## ¿Variables de entorno?

| Env | Default | Qué hace |
|--|--|--|
| `MIRANDA_ENABLED` | `off` | Enciende la capacidad. Apagado ⇒ cero superficie (ni ruta ni nav). |
| `ANTHROPIC_API_KEY` | — | Obligatoria si el flag está ON (el arranque aborta si falta). Solo en cabecera, jamás en logs/transcripts. |
| `MIRANDA_MODEL` | `claude-sonnet-5` | Modelo de la Messages API. |
| `MIRANDA_RUBRIC_DIR` | — | Directorio con `dsl.md` (se monta al system prompt) y `qc1.md` (rúbrica del self-check). |
| `MIRANDA_MAX_TURNS` | `40` | Turnos internos (tool-use) máximos por mensaje del usuario. |
| `MIRANDA_TOKEN_BUDGET` | `500000` | Presupuesto de tokens por sesión (se corta con mensaje claro al excederse). |
| `MIRANDA_CATALOG` | — | Ruta a un JSON con el allowlist de catálogo (`[{name,schema?,description?,rows_estimate?}]` o `{catalog:[…]}`). |
| `MIRANDA_SCOPE_GROUP` | `miranda` | Grupo de Mira que concede el scope (además de los admins). |
| `MIRANDA_PROBE_DB` | 1ª conexión | `database_ref` contra el que corren las probes. |
| `MIRANDA_ANNOUNCE_WEBHOOK` | — | Webhook opcional para anunciar la publicación (patrón espejo Slack; no-fatal). |
| `MIRANDA_PREVIEW_IDENTITIES` | — | Ruta a un JSON con el **roster** de identidades inspeccionables en preview (`[{label,user,claims}]`). Sin ella la feature no existe. Roster ilegible o inválido (label duplicado, `user`/`claims` ausentes) **aborta el arranque**. |

## ¿Rutas?

| Ruta | Método | Qué hace |
|--|--|--|
| `/miranda` | GET | Lista de sesiones propias + «Nueva sesión». |
| `/miranda/api/new` | POST | Crea una sesión. |
| `/miranda/s/:id` | GET | La conversación + panel de resumen de intención (botón «Esto es lo que quiero», toggle «ver DSL»). |
| `/miranda/api/s/:id/message` | POST | Un turno del chat. |
| `/miranda/api/s/:id/validate-intent` | POST | El usuario aprueba el resumen (→ `validado`). |
| `/miranda/api/s/:id/publish` | POST | Publica (gates en código). |
| `/miranda/preview/:id` | GET | Sirve el último draft como spec efímero **por `serve-rls`** (RLS real; no aparece en el índice ni en healthz). |
| `/miranda/preview/:id?as=<label>` | GET | El mismo draft rendido con la identidad del roster con esa etiqueta (`MIRANDA_PREVIEW_IDENTITIES`). Etiqueta no declarada ⇒ 404. Cada render impersonado se audita (`miranda-preview-as {session, actor, as}`). Sin roster, el parámetro se ignora. |
| `/miranda/preview/:id/compare?a=&b=` | GET | Dos previews lado a lado (`me` = tu RLS, o una etiqueta), con una banda que nombra cada identidad y sus claims. Azúcar sobre `?as=`. Sin roster, la ruta no existe. |

Toda ruta con `:id` exige **pertenencia**: dueño de la sesión o admin (ajena ⇒ 403). La preview
impersonada NO es un bypass del gate: el actor sigue siendo el usuario autenticado con su scope
`miranda`; lo que cambia es el `IdentityContext` que alimenta la RLS de UN render efímero, y las
identidades suplantables las declara la INSTANCIA (roster), nunca el actor. Los claims del roster se
usan **tal cual** (sin enriquecer desde `VERGIS_IDENTITY_MAP`): el roster es la única fuente de verdad
de lo suplantado. Cada costura falla cerrada: sin roster ⇒ superficie cero; etiqueta no rostered ⇒
404; claim que la política exige y el roster no trae ⇒ cero filas.

AuthZ de la capacidad: scope `miranda` (admin o miembro del grupo de scope). Sin scope ⇒ 403 en todas
las rutas y sin entrada en el menú.

## ¿Contratos de las tools (el cinturón de Miranda)?

| Tool | Input | Salida | Notas |
|--|--|--|--|
| `catalog_tables` | — | objetos del allowlist | Solo el catálogo de instancia (nada de `INFORMATION_SCHEMA` abierto). |
| `describe_table` | `{name}` | columnas+tipos + 3 filas de muestra en `repr()` | `repr()` revela espacios/mayúsculas (guard `'TC '` vs `'TC'`). |
| `profile_column` | `{table, column, top?}` | top-N valores distintos con conteo, en `repr()` | Columna sanitizada (identificador simple). |
| `run_probe` | `{sql, why}` | filas (≤500) o error de guardia | Pasa por `sql-guard` (un `SELECT`, `TOP 500` forzado, allowlist). `why` se registra. |
| `list_pis` / `read_spec` | `{code?}` | specs existentes (read-only) | Ejemplares; no se editan. |
| `save_draft` | `{yaml}` | `{ok, version}` o errores del DSL | Valida (`dsl/parse`+`dsl/validate`) y guarda `spec_draft` vN. **Nunca** escribe al SPECS_DIR. |
| `update_intent_summary` | JSON estructurado | `{ok, version}` | Guarda `intent_summary` vN; invalida `validado` si aplica. |
| `render_preview` | — | `{url}` y, con roster declarado, `{identities:[{label,url}], compare_url}` | Devuelve `/miranda/preview/<session>`. Con `MIRANDA_PREVIEW_IDENTITIES` agrega una URL por etiqueta y la del comparador; **sin roster esos campos no existen**. Los claims nunca viajan a la tool. |
| `run_self_check` | — | `{veredicto, brechas[]}` | Llamada separada al modelo (juez ≠ autor); mueve `validado`→`autochequeado` si no hay B/M. |
| `create_data_request` | `{descripcion, tablas_faltantes[]}` | `{ok}` | Handoff a César+Claude: Miranda especifica, **no construye** datos en esta fase. |

## ¿Guardia SQL de las probes?

Una probe es una lectura **exploratoria**: un único `SELECT`, sin efectos, con `TOP 500` **forzado**
(el `TOP` del usuario se descarta). Se rechaza: multi-statement (`;`), CTE (`WITH`), comment-smuggling
(`--`, `/* */`), DML/DDL, `SELECT … INTO`, `EXEC`/`sp_`/`xp_`, `OPENROWSET`/`OPENQUERY`/`BULK`, y toda
tabla fuera del allowlist. Es defensa en profundidad: la RLS data-anchored filtra las filas igual.

## ¿Self-check QC① (el revisor interiorizado)?

El QC① no muere: se interioriza. Corre como una **llamada separada** al modelo (juez ≠ autor) con la
rúbrica y el método montados por la instancia + el draft + el resumen de intención + los perfiles
`repr()` y las probes de reconciliación. Salida JSON forzada por la tool `emit_qc_report`, con el
**mismo vocabulario cerrado** del método: veredicto (`APROBADA · APROBABLE · NO_APROBABLE ·
NO_REVISABLE`) y brechas (`B · M · m · i`). El gate de `publish` vive en código: rechaza con B/M abiertas.

**Forma por vista (guard anti-F-01).** El resumen de intención lleva `vistas[]`: por cada vista del PI,
su `forma` (`tabla · dashboard · mixta`) y sus `piezas` (`tarjetas · graficos · tabla`). Es la intención
VISUAL, validable por el usuario sin leer el DSL. El self-check la cruza contra las piezas reales del
draft (KPI/dato→tarjetas, chart/series/distribution→graficos, table→tabla): una vista cuya forma o piezas
declaradas no calzan con lo que dibuja el draft —o un draft visual sin forma declarada— es brecha `M`.
Este cruce es enforcement en código (`crossCheckForma`), no solo prompt.

## ¿Qué NO hace Miranda (Fase 1)?

Ejecutar DDL/DML, escribir al terreno, tocar policies, reiniciar servicios, construir datos nuevos
(handoff con `create_data_request`), editar PIs nacidos del proceso Jira, ni decidir alcance de
gobierno. Su única escritura al mundo es (a) artefactos de sesión y (b) el YAML del spec al publicar.

---

*Parte de la implementación de referencia de AgencyDomains. Ver el cluster 077 del lab A.R.B.O.L. para
la visión y el plan de fases.*
