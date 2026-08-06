# Diseño #109 — `options_ref`: catálogo de la instancia como fuente de opciones de un campo de metadata

> Contrato de delegación wingcoding: **Fable diseñó, Opus implementa en frío.** Este documento es
> autocontenido: todo lo que hay que saber está aquí o en las rutas exactas que se citan.
> Issue: <https://github.com/Gegolabs/vergis/issues/109> · Cluster 002.
>
> **Precedencia de fuentes:** este documento > issue #109 > issue #76 (contrato de metadata) >
> código actual en `main` (`10393e0`). Si el código difiere de lo citado (línea corrida por otro
> merge), manda la *descripción* del punto, no el número de línea: localizar por el patrón citado.

## ¿Qué pide el issue?

Que un campo de metadata del intake (#76) pueda tomar sus opciones de un **catálogo de la
instancia** en vez de ser texto libre validado. Caso motivador: `empresa_rut` en la vista de
Cargas — con un catálogo de empresas (RUT + nombre) el campo pasa a ser un **dropdown** y el error
de tipeo deja de ser posible en vez de ser detectado. El catálogo es dato de la **instancia**; el
Producto define cómo se declara la referencia y cómo se resuelve, no qué hay dentro.

`options_ref` ya está **declarado en el contrato pero fail-closed**: un slot que lo use no arranca
(«no soportado aún», `packages/capabilities/src/intake.ts:194-198`). Este diseño lo enciende.

## ¿Qué hay hoy en el código? (inventario verificado)

Todo verificado leyendo `main` (`10393e0`):

| Qué | Dónde | Estado hoy |
|---|---|---|
| Contrato del campo de metadata (`IntakeMetaField`: `id/label/type/required/options/options_ref/fromFilename`) | `packages/capabilities/src/intake.ts:77-93` | `options_ref?: string` declarado; `options?: string[]` solo inline |
| Fail-closed de `options_ref` | `intake.ts:194-198` | `parseMeta` **lanza** si el campo lo declara |
| Validación server-side de metadata | `intake.ts:406-441` (`validateMeta`) | enum: `(f.options ?? []).includes(raw)` con mensaje genérico `'…' no es una opción válida.` (`:430`) |
| Derivación desde el nombre (#95) | `intake.ts:44-69, 339-391` | `from_filename` con su propio `catalog` **token→valor** (mapa inline); `validateMeta` resuelve por archivo y el valor derivado pasa por el mismo `switch` de tipos |
| Handler del POST de subida | `server/admin.ts:419-493` (`handleIntakeUpload`) | lee campos `meta_<id>` del multipart y llama `validateMeta` (`:453-464`) — la validación del browser es cortesía, esta es la que manda |
| Render del formulario | `server/admin.ts:808-847` (`metaFieldsHtml` + `uploadForm`) | enum → `<select>` con `<option value="V0">V0</option>` (`:823-825`) |
| Declaración de la instancia | `VERGIS_INTAKE` = **un** archivo YAML (`intake/slots.yaml`), clave raíz `slots` | `server/serve-rls.ts:391-392` (`parseIntakeFile`) |
| Fail-closed al arranque | `server/deployment-check.ts:100-107` (chequeo 1·quater) | parsea el YAML de `VERGIS_INTAKE` con `parseIntakeConfig`; un `throw` = ERROR ruidoso (modo `strict` aborta) |
| Hot-reload con validate-before-swap | `server/serve-rls.ts:1303-1310` (`reloadDomainGovernance`) + watch de `VERGIS_INTAKE` en `:1367` | `parseIntakeFile()` dentro de `try/catch`: si lanza, **conserva los slots vigentes** y loguea |
| Master data | `packages/capabilities/src/master-data.ts` (contrato), `master-data-store.ts` (SQLite/DWH), `master-data-publish.ts` | catálogo **gobernado por tabla** (CRUD en admin, publicación `__replica` para JOIN); requiere `VERGIS_MASTER_DATA` y un store; su lectura es **async** y por motor |
| Sidecar | `intake.ts:461-470` (`buildSidecar`) | viaja el **valor** de cada campo (`{ slot, empresa_rut: "…", … }`) |

**Punto de apalancamiento** (verificado, no conjetura): el chequeo de arranque, el hot-reload y el
handler de subida consumen **todos** el resultado de `parseIntakeConfig` / `validateMeta`. Todo lo
que se valide en el parser cae fail-closed gratis en el arranque (deployment-check) y en el
hot-reload (validate-before-swap), sin tocar ninguno de los dos módulos.

## Decisiones selladas

### D1 — El catálogo vive en el MISMO YAML de intake (`VERGIS_INTAKE`), bloque raíz `catalogs:`

Ni tabla de GovernanceStore, ni master data, ni archivo aparte. Racional:

1. **Fail-closed gratis y total**: la resolución de la referencia ocurre en `parseIntakeConfig`
   (parse-time). Una ref rota o un catálogo vacío **lanzan** → el deployment-check (1·quater,
   `deployment-check.ts:100-107`) lo acusa como ERROR al arranque y el hot-reload
   (`serve-rls.ts:1303-1310`) rechaza el swap conservando lo vigente — **cero código nuevo en esos
   dos módulos**.
2. **Hot-reload gratis**: `watchPaths` ya observa `VERGIS_INTAKE` (`serve-rls.ts:1367`); editar el
   catálogo recarga los slots sin restart.
3. **Mismo dueño, misma revisión**: quien mantiene los slots mantiene el catálogo (config
   declarativa versionada de la instancia — el flujo repo→despliegue de la Ley, no edición runtime).
4. **Precedente interno**: `from_filename.catalog` (#95) ya es dato de instancia dentro de ese
   mismo YAML.

Por qué NO las otras dos: una **tabla de GovernanceStore** convertiría config declarativa en estado
runtime y exigiría una UI CRUD que el issue no pide (scope creep pre-launch); **master data**
exigiría `VERGIS_MASTER_DATA` + un store cuya lectura es async y por motor (DWH = red) dentro de la
validación de cada subida, y el issue dice explícitamente que no debe exigirla. **Extensión
futura** (fuera de alcance, no implementar): un catálogo podrá declararse con respaldo master data
bajo el MISMO contrato de referencia — `options_ref: <id>` es el nombre estable; qué respalda al
catálogo es asunto de su declaración, no de los slots que lo referencian.

### D2 — Contrato YAML exacto

```yaml
# intake/slots.yaml de la instancia (VERGIS_INTAKE)
catalogs:                          # opcional; ausente = cero catálogos (legítimo)
  - id: empresas_gh                # slug [a-z][a-z0-9_]*, único entre catálogos
    label: "Empresas del grupo"    # opcional (documentación/UI futura)
    options:                       # lista NO vacía
      - value: "96835510-4"        # el dato que viaja (sidecar/SJD) — único en el catálogo
        label: "Hijuelas S.A."     # lo que ve el usuario; opcional → default = value
      - value: "77130310-2"
        label: "Agrícola El Tranque"
      - "OTRO"                     # string ≡ { value: "OTRO", label: "OTRO" }

slots:
  - id: facturas_documentos
    # …lo existente…
    meta:
      - id: empresa_rut
        label: "Empresa (receptor)"
        type: enum
        required: true
        options_ref: empresas_gh   # string plano: el contrato YA declarado en IntakeMetaField
```

- **La referencia es un string plano** (`options_ref: empresas_gh`), como ya declara
  `IntakeMetaField.options_ref?: string` (`intake.ts:89`). **Sin selectores campo-valor/campo-etiqueta
  en el slot**: el catálogo *owns* su forma (las llaves canónicas `value`/`label` de sus entradas).
  Si mañana un catálogo se respalda en master data, el mapeo columna→value/label se declarará EN el
  catálogo — los slots que lo referencian no cambian.
- Reglas del bloque `catalogs`: lista; cada elemento `{ id, label?, options }`; `id` con el mismo
  `SLUG_RE` de los slots, duplicado = error; `options` lista no vacía; entrada = string o
  `{ value, label? }`; `value` trim no vacío, **duplicado dentro del catálogo = error**; `label`
  ausente → `label = value`. Un catálogo declarado y no referenciado es válido (no warning).
- Reglas del campo: `options_ref` **solo** para `type: enum` (igual que `options` hoy, `:203-204`);
  `enum` exige **exactamente uno** de `options` | `options_ref` (ninguno = error «requiere
  'options' u 'options_ref'», ambos = error «declara 'options' u 'options_ref', no ambos»);
  `options_ref` a un id no declarado = error nombrando la ref y los catálogos declarados (o «no hay
  catálogos declarados (bloque `catalogs:`)» si el bloque falta).

### D3 — Representación interna normalizada: `options` pasa a `{ value, label }[]`

```ts
/** Opción de un enum, normalizada: inline y catálogo convergen aquí. */
export interface IntakeMetaOption { value: string; label: string }

export interface IntakeMetaField {
  // …igual…
  /** Opciones RESUELTAS para type enum (inline o desde `options_ref`; label = value si no hay etiqueta). */
  options?: IntakeMetaOption[]
  /** Id del catálogo del que salieron las options (solo mensajes/UI; el valor ya viene resuelto). */
  optionsRef?: string
  // el campo crudo `options_ref?: string` del contrato actual se REEMPLAZA por `optionsRef` resuelto
}
```

Criterio de excelencia: **una sola forma normalizada** en vez de `string[]` + un mapa paralelo de
etiquetas. Las `options` inline (strings YAML) se normalizan a `value = label`; las entradas
`{value,label}` también se aceptan inline (mismo parser de entrada que el catálogo). Precedente en
el propio repo: `render-html-piece.ts:182` (`typeof o === 'string' ? { value: o, label: o } : o`).
La resolución de `options_ref` copia las opciones del catálogo **al campo** en parse-time: el
`IntakeSlot` resultante es autocontenido (nada más transporta catálogos), el diff
`JSON.stringify` del hot-reload (`serve-rls.ts:1304`) detecta un cambio de catálogo sin código
nuevo, y `validateMeta` ni el sidecar necesitan conocer el bloque `catalogs`.

Consumidores de `f.options` a ajustar (los ÚNICOS dos, verificado por grep):
`validateMeta` (`intake.ts:430`) y `metaFieldsHtml` (`admin.ts:824`).

### D4 — Render: `<select>` simple; texto `label · value`; NO `datalist`

- Se conserva el control actual (`<select>` con `<option value="">— elegir —</option>` y
  `required` cuando aplica, `admin.ts:823-825`); solo cambia el mapeo de opciones:
  `value` del option = `o.value`; texto visible = `o.label · o.value` cuando `label ≠ value`,
  solo `o.value` cuando son iguales (los enums inline actuales renderizan IDÉNTICO a hoy —
  regresión cero, el test existente `admin-domain-intake.test.ts:334` que espera
  `<option value="V0">V0</option>` sigue verde).
- **No `datalist`**: un `<input list=…>` acepta texto libre — reintroduce exactamente el error que
  el issue elimina («el error deja de ser posible»); además su comportamiento varía entre browsers.
  El `<select>` nativo ya ofrece type-ahead por teclado. Los catálogos esperados son O(10–100)
  entradas (empresas de un grupo).
- El caso motivador muestra `Hijuelas S.A. · 96835510-4`: el usuario elige por nombre y verifica el
  RUT a la vista; lo que viaja en el POST es el RUT (el `value`).

### D5 — Validación server-side fail-closed: pertenencia por `value` en `validateMeta`

La rama `enum` de `validateMeta` (`intake.ts:424-437`) pasa a
`(f.options ?? []).some((o) => o.value === raw)`. Como `validateMeta` es la MISMA función que corre
el handler del POST (`admin.ts:457`) y la del browser es cortesía declarada (`intake.ts:83`,
`admin.ts:448-450`), **manipular el HTML no la salta**: un `value` fuera del catálogo rechaza el
lote completo (misma atomicidad de #76). Mensajes (reemplazan el genérico de `:430` SOLO cuando hay
`optionsRef`; el inline conserva su mensaje actual):

- Campo de formulario: `«Empresa (receptor)»: '12345678-5' no está en el catálogo «empresas_gh».`
- Campo derivado del nombre (D6): ver abajo.

El comentario `intake.ts:429` («`options` siempre está presente…») se actualiza: sigue siendo
cierto — el parse garantiza `options` resueltas para todo enum, venga de inline o de ref.

### D6 — `from_filename` (#95) + `options_ref`: permitido, doble compuerta, mensajes decididos

Un campo `enum` puede declarar `from_filename` **y** `options_ref` a la vez. Semántica en
`validateMeta` (sin tocar `deriveMetaFromFilename`):

1. El nombre resuelve el token; si `from_filename.catalog` (token→valor) existe, mapea — errores
   existentes de #95 intactos (nombre fuera de convención / token fuera del catálogo de tokens).
2. El valor resuelto pasa por la compuerta enum de D5 **igual que un valor de formulario**: si no
   está en el catálogo de la instancia, la carga falla con mensaje que nombra archivo y catálogo:
   `El valor '96835510-4' derivado del nombre 'Listado EasyDoc VH.xlsx' no está en el catálogo «empresas_gh» de «Empresa (receptor)».`

`validateMeta` ya sabe la procedencia (rama `f.fromFilename`, `:411-417`): basta un flag local
`derivado` para elegir el mensaje. Nota de diseño: `from_filename.catalog` y el bloque `catalogs`
son cosas distintas (mapa token→valor vs lista de valores válidos) y **no** se unifican aquí.

### D7 — Catálogo vacío o ref rota → fail-closed en arranque y hot-reload, SIN código nuevo ahí

Toda la invariante vive en el `throw` de `parseIntakeConfig` (D2). Verificado en código, no
conjetura: (a) el arranque parsea `VERGIS_INTAKE` con esa función en `deployment-check.ts:100-107`
y en modo `strict` (default) aborta con ERROR ruidoso; (b) el hot-reload la llama dentro de
`try/catch` que conserva los slots vigentes y loguea (`serve-rls.ts:1303-1310`). La corrida que lo
demuestra (Norma 7) son los tests T3/T4: un YAML con ref rota produce el finding de
deployment-check y el `throw` del parser — el mismo `throw` que el catch del hot-reload captura.

### D8 — El sidecar no cambia

Viaja el `value` (`{ slot, empresa_rut: "96835510-4", … }`); el `label` es puro display y **jamás**
viaja al sidecar ni al SJD. `buildSidecar` (`intake.ts:461-470`) queda intacto.

### D9 — Coordinación con #62 y #117 (integración secuencial)

- **#62** (tabla `intake_upload` + pre-check de duplicado) toca `handleIntakeUpload`
  (`admin.ts:419-493`) y GovernanceStore. Este diseño **no toca** ese handler: en `admin.ts` el
  territorio se acota a `metaFieldsHtml` (`:808-836`). El único roce posible es import/línea.
- **#117** (fail-closed ante clave raíz ausente) también edita `parseIntakeConfig` e
  `intake.test.ts`. `catalogs` es clave raíz **opcional**: su ausencia es legítima (cero catálogos)
  y NO cae bajo la regla de #117 (que aplica a `slots`). Si #117 llega primero, este diseño se
  rebasea encima sin cambio conceptual; el conflicto esperado es textual en el arranque de
  `parseIntakeConfig`.

## Territorio (exacto)

| Archivo | Qué se toca |
|---|---|
| `packages/capabilities/src/intake.ts` | tipos (`IntakeMetaOption`, `options`/`optionsRef` en `IntakeMetaField`), `parseIntakeConfig` (bloque `catalogs` + resolución + normalización de `options` inline), `parseMeta` (reglas D2, retirar el throw «no soportado» `:194-198`), `validateMeta` (rama enum D5/D6) |
| `packages/capabilities/src/index.ts` | exportar `IntakeMetaOption` (línea 89, junto a los otros types de intake) |
| `server/admin.ts` | SOLO `metaFieldsHtml` (`:808-836`): mapeo de options a `<option value/label>` |
| `tests/intake.test.ts` | actualizar expectativas (`:91` forma nueva de `options`; `:104` reemplazar «no soportado» por los casos D2) + casos nuevos de parse y `validateMeta` |
| `tests/admin-domain-intake.test.ts` | caso de render del dropdown con catálogo (patrón del test `:327-335`) |
| `tests/deployment-check.test.ts` | caso: YAML con `options_ref` rota → finding `error` en `VERGIS_INTAKE` |
| `work/002-cluster-requests-2026-08/…` | este documento (ya escrito) |

**Intocables**: `server/deployment-check.ts`, `server/serve-rls.ts`, `server/hot-reload.ts`,
`server/multipart.ts`, `intake-onelake.ts`, `buildSidecar`/`deriveMetaFromFilename`/`validateRut`,
todo master-data, y `handleIntakeUpload` (territorio de #62). Si al implementar parece necesario
tocar uno, la premisa de D1/D7 está rota: **detenerse y reportar**, no improvisar.

## Tareas y «hecho cuando»

**T1 — Contrato + parser (`intake.ts` + `index.ts`)**
Tipos D3; `parseIntakeConfig` lee `catalogs` (reglas D2: lista, ids slug únicos, options no vacías,
entradas string|{value,label?}, values únicos), valida ANTES de los slots, y `parseMeta` recibe los
catálogos para resolver `options_ref` (exactamente-uno con `options`, solo enum, ref existente,
copia resuelta + `optionsRef`). Options inline normalizadas a `IntakeMetaOption[]` (string y
{value,label} admitidos).
*Hecho cuando:* `npx vitest run tests/intake.test.ts` verde incluyendo casos nuevos: (1) ref
resuelta → `options` con labels y `optionsRef` seteado; (2) ref desconocida → `/catálogo desconocido/`;
(3) catálogo sin options → throw; (4) `value` duplicado → throw; (5) id de catálogo duplicado →
throw; (6) `options` + `options_ref` juntos → `/no ambos/`; (7) `options_ref` en type no-enum →
throw; (8) enum sin ninguno → throw; (9) entrada string ≡ `{value,label}` iguales; (10) inline
`['V0','V1','V2']` → `[{value:'V0',label:'V0'},…]` (expectativa `:91` actualizada).

**T2 — Validación server-side (`validateMeta`)**
Rama enum por `o.value` (D5) + mensajes con catálogo y variante derivada (D6).
*Hecho cuando:* `npx vitest run tests/intake.test.ts` verde con: (a) valor fuera del catálogo →
`ok:false` y mensaje que nombra `«empresas_gh»` (es el gate del POST: HTML manipulado no lo salta);
(b) valor dentro → `ok:true` con el `value` en `values`; (c) enum inline conserva su mensaje actual;
(d) campo `from_filename` + `options_ref`: derivado fuera del catálogo → mensaje con archivo y
catálogo; derivado dentro → sidecar values correcto.

**T3 — Render del dropdown (`admin.ts:metaFieldsHtml`)**
Mapeo D4.
*Hecho cuando:* `npx vitest run tests/admin-domain-intake.test.ts` verde con: el form del slot con
`options_ref` contiene `<option value="96835510-4">Hijuelas S.A. · 96835510-4</option>` (y el
placeholder «— elegir —»); el test existente `:334` (`<option value="V0">V0</option>`) sigue verde
sin editarlo (regresión cero del inline).

**T4 — Fail-closed de despliegue (test de deployment-check)**
Sin tocar `deployment-check.ts`: escribir un YAML temporal con `options_ref` rota, setear
`VERGIS_INTAKE` en el env del test y afirmar el finding `{ level:'error', env:'VERGIS_INTAKE' }`
cuyo mensaje nombra la ref (patrón de los tests existentes de ese archivo).
*Hecho cuando:* `npx vitest run tests/deployment-check.test.ts` verde. Este test ES la corrida que
demuestra D7 para el arranque; para el hot-reload, el mismo `throw` es lo que el catch de
`serve-rls.ts:1303-1310` (código preexistente, no tocado) captura.

**T5 — Gates completos**
*Hecho cuando:* `npm run typecheck && npm test && npm run build` — los tres verdes. Es el juez.

Orden: T1 → T2 → T3/T4 (independientes entre sí) → T5. Todo cabe en un solo frente/PR.

## Reglas duras

1. **Fail-closed siempre**: ante cualquier duda del parser, `throw` con mensaje accionable en
   español que nombre slot/campo/catálogo — nunca un default silencioso ni una opción imputada.
2. **El `label` jamás viaja**: sidecar, audit y SJD ven solo `value`.
3. **No tocar los intocables** (lista arriba). En particular NADA en `handleIntakeUpload` (#62).
4. **Regresión cero** para YAML existentes: slots sin `meta`, enums inline y `from_filename` de #95
   se comportan y renderizan idéntico (los tests existentes no se debilitan; solo se ajusta la
   forma interna de `options` donde el test la inspecciona).
5. **Sin scope creep**: nada de catálogos respaldados en master data, ni UI de gestión de
   catálogos, ni búsqueda con JS en el select, ni unificar `from_filename.catalog` con `catalogs`.
6. Estilo del repo: comentarios/mensajes en español, referencia al issue (`issue #109`) en los
   docstrings nuevos, mismos patrones de error que el parser actual.

## Juez

`npm run typecheck && npm test && npm run build` (los tres gates del repo) + los «hecho cuando» por
tarea. No hay gate humano ni recursos externos: todo es puro/testeable en vitest.

## Riesgos

- **Choque de merge con #62/#117** (ambos en vuelo): mitigado por territorio (D9); la integración
  es secuencial y el conflicto esperado es textual, no conceptual. Quien integre segundo rebasea.
- **Catálogos grandes** (miles de entradas): el `<select>` nativo degrada en UX (no en corrección).
  Aceptado — fuera del caso motivador (O(10–100)); si aparece, es un issue de UI futuro, no de
  contrato.
- **Cambio de forma de `IntakeMetaField.options`** (`string[]` → `IntakeMetaOption[]`): rompe a
  cualquier consumidor no detectado. Mitigado: grep verificado (solo `validateMeta` y
  `metaFieldsHtml`) y el typecheck del monorepo lo acusaría en compilación.
- **Duplicidad futura catálogo YAML ↔ master data** en instancias que ya gobiernan empresas como
  entidad master data: asumida a conciencia (se declara dos veces hasta que exista el respaldo
  `source: master-data` bajo el mismo contrato de referencia — extensión anotada en D1, no
  bloqueante).

— Diseño: Claude (Fable 5) · 2026-08-06 · rama de trabajo sugerida: `feat/intake-options-ref`
