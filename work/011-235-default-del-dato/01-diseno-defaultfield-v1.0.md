# Diseño — el default de un control puede venir DEL DATO (`defaultField`) · #235 + #246

**Versión 1.0** · 2026-08-19 · Autor: Simón Alero (Fable) · Ejecutor previsto: Opus, en frío

> **Para quién es.** Para el ejecutor que implementa esto **sin haber estado en la conversación que lo
> originó**. Todo lo que hace falta para decidir está acá; lo que no esté escrito acá es una decisión
> que te toca a ti y que tienes que **declarar** en el cuerpo del PR.

---

## 1 · El problema, en una línea

Un control no puede señalar como default una opción **móvil** — una que se define por su relación con
*hoy* y no por su posición en el dominio. El caso real: la proyección semanal de PI-12 debe abrir en
**la semana siguiente a hoy**, y su spec exige además poder elegir la semana en curso u otra, o sea un
dominio que se extiende hacia el futuro.

Los defaults disponibles son `max` (la mayor del dominio), `min`/`first` (la menor) y el literal de
#92. Ninguno sirve: **el literal caduca** —`2026-08-24` es «la semana siguiente» durante siete días y
al octavo apunta al pasado— y **`first` no da acceso al orden del SQL**, porque
`buildControlOptions` termina con `pairs.sort((a,b) => cmpVals(a.value,b.value))` y descarta el orden
de las filas. El *workaround* vigente acota el dominio a `[hoy−4 … hoy+1]` para que la siguiente sea
el `max`: arregla el default y **rompe el requisito**, porque el usuario ya no puede mirar más allá.

**La solución pedida**: que el **dato** designe la opción por defecto, ya que el dataset de opciones lo
produce el mismo SQL que conoce el calendario.

```yaml
controls:
  - id: semana
    source: data.semanas.semana
    display: etiqueta
    defaultField: es_default    # columna del MISMO dataset
```

---

## 2 · Lo que el issue #235 NO vio, y cambia la implementación

El issue está bien pensado y su alternativa descartada (un mini-lenguaje de fechas, `default: today+1w`)
está bien descartada: mete un vocabulario de expresiones temporales para un caso que el SQL ya resuelve,
y no generaliza a defaults móviles no temporales («la campaña vigente», «el período contable abierto»).

Pero el reconocimiento del código encontró **seis cosas** que el issue no contempla. Las seis son
decisiones que hay que tomar acá, no en el teclado.

### 2.1 · El default literal de #92 está MUERTO, y es prerrequisito (issue #246)

`schema/mira-spec.schema.json:54` cierra el vocabulario:

```json
"default": { "enum": ["max", "min", "first"] },
```

El schema es el **primer** paso de `validateSpec` y lanza antes de la validación semántica. Medido con
AJV y el schema real, aislando con control positivo: con `default:"max"` el `enum` no se queja, con
`default:"W32"` sí. O sea **#92 se publicó y su capacidad es inalcanzable desde un spec**.

**Consecuencia para este frente**: el issue dice «tres defaults actuales» y en realidad hay dos usables.
Y más importante: **el mismo `enum` bloquearía cualquier cosa nueva**. Arreglar #246 no es un vecino de
#235: es su primer paso.

### 2.2 · «Cae al comportamiento sin default» no significa «sin selección»

`resolveControlValue` (`packages/mira/src/controls.ts:61-72`) termina así:

```ts
const sorted = [...options].sort(cmpVals)
return def === 'min' ? sorted[0] : sorted[sorted.length - 1]
```

El fallback universal —`undefined`, `max`, y el literal fuera de dominio— **es `max`**. El issue dice
que `defaultField` que no resuelve «cae al comportamiento sin default, igual que el literal»; eso es
correcto **y concretamente significa `max`**. Escríbelo así en la doc y en el test, porque «sin
default» invita a implementar «sin selección», que es otra cosa.

### 2.3 · Una clave desconocida se ignora EN SILENCIO

`controls.items` tiene `"additionalProperties": true` (`schema/mira-spec.schema.json:47` — nota que
`filters.items` tiene `false`, los controles son la excepción laxa) y `validateControls`
(`packages/mira/src/dsl/validate.ts:718-832`) **no tiene lista blanca de claves**. Medido con AJV: un
control con `defaultField` y con una clave inventada pasa la validación sin decir nada.

**Consecuencia**: `defaultField` funcionaría sin tocar el schema, y **un typo en su nombre no diría
nada** — el control caería a `max` y nadie se enteraría de por qué el PI abre en la semana equivocada.
Eso contradice la doctrina fail-loud de toda esta base. Por eso el schema y la validación del campo
colgante **no son opcionales en este frente**.

### 2.4 · La regla del dueño del `param`

`packages/mira/src/mira.ts:322-326`:

```ts
const isOwner = !paramOwned.has(param)
paramOwned.add(param)
// El default lo aplica SOLO el dueño (los demás heredan el valor que el dueño ya fijó).
const def = isOwner ? c.default : undefined
```

Dos controles con el mismo `param` son **llaves alternativas** del mismo alcance. `defaultField` tiene
que respetar la misma regla: **solo el dueño lo aplica**. Si no, la segunda llave pisaría el valor que
fijó la primera.

### 2.5 · El criterio de verdad del booleano hay que DECLARARLO

El issue dice «columna booleana» y el pipeline no tipa nada: las filas son `Record<string, unknown>`
con los valores **crudos del driver**. Lo que puede llegar en esa columna:

| Origen | Valor JS |
|---|---|
| `BIT` de mssql/tedious | `true` / `false` |
| `CAST(… AS INT)` | `1` / `0` |
| Un `CASE WHEN … THEN 'S' ELSE 'N'` | `'S'` / `'N'` |
| `NULL` en las filas no-default | `null` |

**La trampa concreta**: `String(false)` es `'false'`, que es **truthy**. Un `if (String(v))` daría
verdadero para todas las filas.

**Decisión, y es normativa**: se acepta como verdadero **exactamente** `true`, `1`, `'1'`, `'true'`,
`'t'`, `'s'`, `'si'`, `'sí'`, `'y'`, `'yes'` (comparación en minúsculas, con `trim`). **Todo lo demás
—incluidos `false`, `0`, `'0'`, `'false'`, `'N'`, `null`, `undefined` y la cadena vacía— es falso.**
Nada de truthiness de JavaScript. Un valor que no está en ninguna de las dos listas (por ejemplo
`'quizás'`) es **falso**, no error: el dominio lo produce el SQL y puede moverse bajo un spec quieto,
que es el mismo argumento del fail-safe de #92.

Documenta la lista en el TSDoc del campo. Un especificador tiene que poder leer qué cuenta como
verdadero sin abrir el código.

### 2.6 · «Exactamente una» se cuenta sobre OPCIONES, no sobre filas

`buildControlOptions` **deduplica por `value`** (primera aparición gana) y **descarta el `value`
vacío**. Dos consecuencias que hay que respetar al contar:

- Si el SQL devuelve el mismo `value` en dos filas y una trae el flag, **hay una sola opción**: contar
  sobre filas diría 2 y el default se perdería por una condición que el usuario no puede ver.
- Una fila con el flag verdadero cuyo `value` sea vacío **no es una opción**: no debe contar.

**Decisión**: el conteo se hace sobre el conjunto de **opciones ya resueltas**, después del dedup y del
descarte del vacío. Con dedup, si dos filas del mismo `value` traen flags distintos, gana **la primera
aparición** — la misma regla que ya rige para la etiqueta, y por la misma razón: una sola regla de
desempate para todo el control.

---

## 3 · La semántica, cerrada

| # | Regla |
|---|---|
| **S1** | Si `defaultField` está declarado y **exactamente una** opción resuelta lo trae verdadero, **esa opción es el default**. |
| **S2** | Si **ninguna** o **más de una** lo traen, `defaultField` **no resuelve** y se evalúa `default` si está declarado; si tampoco resuelve, se cae al fallback universal (**`max`**). Fail-safe, no fail-closed. |
| **S3** | La **URL gana siempre**: un `ctx.<param>` presente y dentro del dominio se sirve, sin mirar ningún default. |
| **S4** | `defaultField` y `default` **conviven**: `defaultField` gana cuando resuelve; si no, se evalúa `default`. |
| **S5** | Solo el **dueño del `param`** aplica `defaultField` (§2.4). |
| **S6** | El **campo colgante es error de spec**, ruidoso, en validación estática (§2.3). |
| **S7** | El **conteo es sobre opciones resueltas** (§2.6) y el criterio de verdad es la lista cerrada de §2.5. |

**Por qué S2 es fail-safe y no un error ruidoso**: el conteo depende del **dato**, que se resuelve por
SQL en cada render. Un SQL que un día devuelve dos filas marcadas dejaría el PI **caído** si esto
fuera fail-closed, y la causa estaría en el warehouse, no en el spec. La misma razón por la que el
literal de #92 no revienta cuando sale del dominio. Lo que **sí** tiene que pasar es que se **vea**:
ver §5·O2.

---

## 4 · Dónde va cada cosa

El reconocimiento dejó el terreno mapeado. Esta es la implementación propuesta; si encuentras una
mejor, **cámbiala y declara el porqué en el PR** — lo que no se negocia es la semántica de §3.

### 4.1 · El schema (`schema/mira-spec.schema.json`)

Dos cambios, y el primero es #246:

```json
"default": {
  "description": "Valor inicial: max | min | first, o un VALOR LITERAL del dominio (#92).",
  "type": "string", "minLength": 1
},
"defaultField": {
  "description": "Campo booleano del MISMO dataset de source que designa la opción por defecto (#235). Gana sobre `default` cuando exactamente una opción lo trae verdadero.",
  "type": "string", "pattern": "^[a-zA-Z0-9_]+$"
}
```

El `pattern` es el mismo de `display`, que es el campo hermano (también nombra una columna del mismo
dataset). Abrir `default` a `{type:string, minLength:1}` es exactamente lo que la validación semántica
ya exige (`validate.ts:783-795`): dos fuentes del mismo contrato que ahora dicen lo mismo.

### 4.2 · El tipo (`packages/mira/src/dsl/validate.ts:639-670`, `interface MiraControl`)

`defaultField?: string`, con TSDoc que traiga: qué hace, la lista de valores verdaderos de §2.5, que
gana sobre `default` cuando resuelve, que cae a `default`/`max` cuando no (S2), y que solo lo aplica el
dueño del `param`.

### 4.3 · La validación (`validateControls`)

Un check nuevo, **calcado del de `display`** (`validate.ts:771-782`, que es el precedente exacto):
`defaultField` que no esté en `shape.fields` del dataset de `source` → `VergisError` con
`code: 'control-default-field-dangling'`, su `path`, su `message` nombrando campo y dataset, y su
`remediation`. Mismo tono que los vecinos.

### 4.4 · La resolución

**Recomendado**: una función nueva y exportada en `packages/mira/src/controls.ts`, al lado de
`buildControlOptions`:

```ts
/** La opción que el DATO designa por defecto, o `undefined` si el dato no designa exactamente una. */
export function defaultFromField(
  rows: Record<string, unknown>[],
  valueField: string,
  defaultField: string,
): string | undefined
```

Que deduplique con **la misma regla** que `buildControlOptions` (primera aparición por `value`, descarte
del vacío) y devuelva el `value` **solo si hay exactamente uno** marcado.

En `resolveHeaderControls` (`packages/mira/src/mira.ts:305-352`) las filas están en el mismo scope
(`results[dsName].rows`), así que no hace falta tocar el transporte de datos ni la forma de
`ControlOption`. El `def` que se pasa a `resolveControlValue` queda:

```ts
const delDato = isOwner && c.defaultField
  ? defaultFromField(results[dsName]?.rows ?? [], field, c.defaultField)
  : undefined
const def = isOwner ? (delDato ?? c.default) : undefined
```

**Por qué así y no dentro de `resolveControlValue`**: `defaultFromField` necesita las **filas** y
`resolveControlValue` solo recibe los `value`s. Pasarle las filas cambiaría su firma —que es pública y
la usan `resolveControlValues` y los tests— sin ganar nada. Y el `??` hereda gratis las reglas S2, S3 y
S4: el valor del dato entra por la misma puerta que el literal, así que **la URL sigue ganando sin que
haya que escribir una línea** para eso. No repliques la precedencia a mano en `resolveHeaderControls`:
es el error que este diseño evita.

**Sutileza de S4 que hay que respetar**: el `??` hace que un `defaultField` que no resuelve caiga a
`c.default`, y de ahí al fallback `max` si tampoco resuelve. Eso ES S2. Verifica que el resultado del
dato, cuando existe, pase por el mismo camino de literal que #92 —o sea que se valide contra las
opciones resueltas— porque un `value` marcado en el dato que **no** esté entre las opciones (no debería
pasar, pero el dato manda) tiene que caer a `max`, no seleccionar algo inexistente.

### 4.5 · Multi-select

`resolveControlValues` delega todo en `resolveControlValue`, así que **no hay que tocarlo**: el default
del dato puebla la selección igual que el literal. Cúbrelo con un test.

---

## 5 · Observabilidad — lo que hace que S2 no sea un silencio

`resolveHeaderControls` ya emite `mira-control-source` por control. **Emite un evento cuando
`defaultField` está declarado y no resuelve**, distinguiendo los dos casos (ninguna marcada · más de
una), con el control, el dataset, el campo y el conteo. Llámalo `mira-control-default-field`.

- **O1** — resuelve: no hace falta evento (el valor servido ya se observa).
- **O2** — no resuelve: **evento sí**. Es la diferencia entre un fail-safe y un silencio. Un PI que
  abre en la semana equivocada porque el SQL dejó de marcar la fila es exactamente el reporte que va a
  llegar, y tiene que poder diagnosticarse sin adivinar.

---

## 6 · Los tests (`tests/controls-default-field.test.ts`)

Convención del repo: `describe('#235 · …')`, `it(...)` en español con `→` para el resultado. El modelo
exacto es `tests/controls-default-literal.test.ts`, que es el archivo hermano de #92.

**De `defaultFromField`**: exactamente una marcada → ese value · ninguna → `undefined` · dos → `undefined`
(y NO la primera: es S2, no «la primera gana») · el criterio de verdad de §2.5 caso por caso, **con
`false` y `'false'` explícitos** porque son la trampa · `value` vacío con flag verdadero → no cuenta ·
mismo `value` en dos filas, flags distintos → una sola opción, gana la primera aparición.

**De la resolución**: el dato gana sobre `default` cuando resuelve (S4) · cae a `default` cuando no (S2)
· cae a `max` cuando no hay ninguno · **la URL gana sobre el dato** (S3) · un `value` marcado que no
está en las opciones → cae a `max` · multi-select se puebla con el del dato.

**De validación**: `defaultField` colgante → rechazo con `control-default-field-dangling` (molde:
`it('display con campo colgante (no está en shape.fields) → rechazo')` en `tests/alt-key-controls.test.ts`).

**De llaves alternativas**: solo el dueño del `param` aplica `defaultField` (S5). Molde:
`it('default max (owner) → ambos sellos en la OC mayor; …')`, mismo archivo.

**De #246, y este es el que faltaba desde agosto**: un `validateSpec` **completo** con `default`
literal que **pase**. Y corrige `tests/controls-multidrill.test.ts:148-152` para que **distinga qué
capa rechaza** — hoy su comentario documenta el `enum` como correcto y por eso el defecto sobrevivió.

**Uno e2e** con `runSpec` y `mock-sql`, del molde de `describe('render · control de cabecera
default=max')` en `controls-multidrill.test.ts`: que el `<option selected>` sea la marcada por el dato
y que el valor viaje **bindeado** a la query.

**Y verifica que no rompes** `tests/notas-ctx-efectivo.test.ts` (#185): publica el ctx efectivo, así que
un cambio en la resolución del default se le ve.

---

## 7 · Documentación

- **`docs/superficie-de-estado.md` §7**, la tabla `Rol | DSL | Default | Qué controla`: fila nueva para
  `defaultField`. Y **§7·1 está desactualizada** —enumera el vocabulario como «`max`/`min`/`first`», sin
  el literal de #92—: corrígela en el mismo cambio.
- **`CHANGELOG.md`**, en «Sin publicar»: la capacidad nueva, **y la entrada que #92 nunca tuvo**
  (verificado: no existe). Que diga las dos cosas — la capacidad que se agrega y la que estaba muerta.

---

## 8 · Lo que este frente NO hace

- **No mete expresiones relativas** (`default: today+1w`). Descartado en el issue y sigue descartado.
- **No cambia `additionalProperties: true`** de `controls.items`. Cerrarlo es correcto pero es un cambio
  de contrato que puede romper specs de instancia con claves que hoy tolera. Va a issue propio si se
  quiere; acá se resuelve el caso concreto declarando el campo.
- **No toca el `sort` de `buildControlOptions`.** El issue observa que descarta el orden del SQL, y es
  cierto, pero `defaultField` resuelve el problema sin depender del orden — que es justamente su
  ventaja sobre `first`.
- **No promete nada sobre PI-12.** Su spec vive en el repo de la instancia, no acá: este frente entrega
  la capacidad, y que el requisito §2.4 quede cumplido se verifica **allá**. Dilo así en el PR — es la
  pregunta del que pidió, no la nuestra.

---

## 9 · Criterios de aceptación

1. `npm run typecheck` · `npm test` · `npm run build` · `npm run lint:shell` en verde.
2. Un spec con `defaultField` **valida** y el control abre en la opción marcada por el dato.
3. Un spec con `defaultField` **colgante** falla ruidoso nombrando campo y dataset.
4. Un spec con `default` **literal** valida y sirve el literal (#246 cerrado, con su test de spec completo).
5. La URL sigue ganando, medido, no razonado.
6. El caso de **dos filas marcadas** cae a `default`/`max` **y emite su evento**.
7. `false` y `'false'` cuentan como falso, con test propio.
8. El PR declara cada desviación de este documento y su porqué.

---

• *Generado con Wingworking*
