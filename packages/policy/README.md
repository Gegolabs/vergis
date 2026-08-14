# @vergis/policy — compilador de policy

Traduce la declaración **`audience.rls`** del spec (engine-agnóstica, doc 3 §6.1) al
**enforcement del motor** (doc 10). Es "el motor RLS como capability del Botler" (doc 8 §6)
en su parte de *compilación*: del QUÉ declarado (Instancia) al CÓMO del engine (Producto).

## Pipeline (un compilador clásico)

```
audience (spec)  ──front-end──▶  Policy IR  ──binder──▶  IR ligado  ──back-end──▶  enforcement
                  parseAudience                bindPolicy              compileClickHouse
```

- **`diagnose.ts`** — por qué una policy niega TODA fila con unos claims (`sin-claim` vs `cardinalidad-eq`). Observabilidad pura: no evalúa filas y no cambia ninguna decisión.
- **`ir.ts`** — el **Policy IR**: pequeño, total, declarativo (predicado = columna × claim × op `in`/`eq`, `and`/`or`, default-deny). Incluye el **evaluador de referencia** (`evalPolicy`), oráculo del property test.
- **`frontend.ts`** — `parseAudience`: `audience` → IR, fail-closed (rechaza malformados; nunca produce policy abierta).
- **`binder.ts`** — `bindPolicy`: valida columna contra el schema del store y claim contra los del gate; liga también las **columnas enmascaradas** de las reglas de columna (mismo error `unknown-column`).
- **`clickhouse.ts`** — `compileClickHouse`: IR → `CREATE ROW POLICY` (back-end del motor B, doc 9 §4) + protocolo de inyección. Incluye `emulate` (semántica ClickHouse en TS) para differential testing sin motor vivo.
- **`index.ts`** — `compilePolicyToClickHouse` orquesta el pipeline (specialize-time, una vez).

## La receta ClickHouse (validada por el PoC de Fase 0)

`audience.rls: [{column: area, claim: groups, op: in}]` compila a:

```sql
CREATE ROW POLICY pol_areas ON vergis.areas
    FOR SELECT
    USING (getSetting('vergis_claim_groups') != '' AND has(splitByChar(',', getSetting('vergis_claim_groups')), area))
    AS permissive
    TO consumer_role;
```

- **Inyección de claims:** custom setting `vergis_claim_<claim>` (uno por claim), valor = `join(claims[claim], ',')`, **request-scoped** (lo escribe el Botler vía `requestSettings`, jamás el consumidor — doc 10 §5). Pooling-safe sin `SET LOCAL`.
- **Default-deny** por el guard `!= ''`: sin inyección → 0 filas.
- **Injection-safe:** el valor del claim viaja como dato del setting, nunca se interpola al SQL. Los **nombres** (columna/claim/rol/tabla) se validan como identificadores seguros.
- **Portabilidad** (doc 9 §7): añadir un engine = añadir un back-end; front-end e IR no se tocan.

## El claim del sujeto es un CONJUNTO (issue #165 §1)

Declarado, porque hasta ahora el código decía «lista» y la semántica de `eq` decía «uno», y nadie
había escrito cuál de los dos era el modelo:

**Un claim es un conjunto de valores, posiblemente unitario.** No es un escalar con una lista como
detalle de transporte. Una persona con dos áreas legítimas —doble dependencia, matriz, proyecto
transversal, interinato— es un sujeto **válido** del modelo, no un dato sucio, y toda la plomería lo
sostiene: el mapa de identidad acepta `string | string[]`, el enriquecimiento normaliza a lista,
`claimValues` devuelve siempre `string[]`, y el codegen lo transporta separado por comas.

Consecuencias, que es para lo que sirve declararlo:

| Predicado | Con un claim de N valores |
|---|---|
| `op: in` | **Unión**: la fila pasa si su celda está en cualquiera de los N |
| Jerárquico (`descendant_of`) | **Unión**: toma los N nodos como ancestros y devuelve la unión de sus descendientes |
| `op: eq` | **Niega, con N ≥ 2** — exige exactamente un valor (`allowed.length === 1`), y el codegen Fabric replica el guard con `CHARINDEX(N',', ...) = 0` |

La negación de `eq` **es correcta y no se toca**: ante dos valores, abrir sería un over-grant y
adivinar cuál es el «bueno» sería inferir identidad. Lo que sí cambió es que dejó de ser muda —
`diagnose.ts` la distingue de «sin claim» y de «sin datos» (`diagnoseClaims`, `deniesAllRows`,
`explainDenial`; el server la emite al armar el índice).

**`eq` no es «`in` con un solo valor»**: es la declaración de que ese criterio no admite pertenencia
múltiple. Una política que quiera la unión ya tiene cómo decirlo — `in` — y esa elección es de la
política, no del accidente de cuántos valores trajo el sujeto.

## Reglas de columna: la máscara (issue #163)

El IR tiene **dos planos ortogonales** y conviene no confundirlos: los predicados (`rls`) deciden
**qué filas** ve el sujeto; las reglas de columna deciden, sobre las filas que la política ya dejó
pasar, **qué celdas** vienen sustituidas por la máscara (`•••`, constante `MASK_VALUE`). El segundo
plano no puede abrir ni cerrar filas: se aplica **después** del filtro, jamás dentro de él. Un PI
público puede tener una columna sensible sin dejar de ser público.

El vocabulario es **fijo y cerrado**: `columna × claim × acción mask`. Se lee *«la columna va
enmascarada para todo sujeto que NO traiga el claim»* — la regla mira la **presencia** del claim, no
su valor. No hay operadores, condiciones (`if:`), ni otras acciones (`hide`, `hash`, `truncate`):
abrir eso convertiría el vocabulario auditable en el «motor de authz disfrazado» que el charter
prohíbe. Una clave de más **rompe**; no se ignora.

### Forma 1 — por tabla (spec `quality.audience.columns` / store legacy `policies[].columns`)

```yaml
quality:
  audience:
    rls: [{column: area, claim: groups, op: in}]
    columns:
      - {column: rut, claim: ve_pii, action: mask}   # `rut` es la columna FÍSICA
```

```yaml
policies:
  - dataset: ref.personas
    grant: all                                        # abierto por fila…
    columns: [{column: rut, claim: ve_pii, action: mask}]   # …y con una columna que no es de todos
```

### Forma 2 — entidad-canónica (la que el charter prefiere)

La regla se declara **una vez en la entidad**, sobre un **atributo canónico**; cada dataset dice qué
**columna física** lo realiza. Es la misma gramática de `governed_by` ↔ `dimensions`, aplicada al
plano de columna:

```yaml
entities:
  - entity: empleado
    governed_by: [{dimension: area, claim: groups, op: in}]
    columns:
      - {column: rut, claim: ve_pii, action: mask}    # `rut` es el ATRIBUTO canónico

datasets:
  - dataset: pi04.empleado
    realizes: empleado
    dimensions: {area: area}
    columns: {rut: rut}                               # atributo → columna física
  - dataset: dbo.dim_empleado
    realizes: empleado
    dimensions: {area: area_name}
    columns: {rut: rut_empleado}                      # el mismo atributo, otra columna
```

**El mapeo es obligatorio y explícito** para cada atributo protegido, aunque el nombre coincida —
igual que `dimensions`. Un default por identidad («si no lo mapeas, se llama igual») produciría, en
el dataset que renombró la columna, una regla que apunta a la nada: sin error y sin máscara.

### Abierto en filas, protegido en columnas — la entidad `grant: all`

Es el caso que **origina** el issue: un dominio que la organización decidió abrir —apertura explícita
y gobernada, no un bypass— y que aun así contiene datos personales. Colapsar «este dominio es
público» con «esta columna es sensible» en una sola decisión es lo que obligaba a la herramienta más
gruesa: **no cargar el dato**.

La apertura de fila se declara **en la entidad**, que sigue siendo el sitio único de autoría — y por
eso convive con `columns`:

```yaml
entities:
  - entity: empleado
    grant: all                                        # fila abierta: todo sujeto ve todas las filas
    columns:                                          # …y celdas que no son de todos
      - {column: rut,    claim: ve_pii,          action: mask}
      - {column: sueldo, claim: ve_remuneracion, action: mask}

datasets:
  - dataset: pi04.empleado
    realizes: empleado
    columns: {rut: rut, sueldo: renta_liquida}        # sin `dimensions`: no hay gobierno que mapear
  - dataset: dbo.dim_empleado
    realizes: empleado
    columns: {rut: rut_empleado, sueldo: sueldo_bruto}
```

Resultado: `{public: true, columnRules: [...]}` — la semántica de fila de `grant: all` queda intacta
(bit a bit la del `grant: all` de un dataset) y la celda se enmascara para quien no traiga el claim.

- `grant` en la entidad es **mutuamente excluyente** con `governed_by` (no vacío): las dos a la vez no
  tienen lectura única, y cualquiera que ganara dejaría al autor creyendo lo contrario de lo que rige.
- Un dataset que realiza una entidad abierta **no declara `dimensions`**: ese mapeo no filtraría nada,
  y creerlo filtrado es la ilusión más cara de esta forma. Rompe.
- Un dataset `grant: all` (sin `realizes`) sigue **sin** admitir `columns:`: no realiza entidad, así
  que no hay atributo que mapear. Ese caso se expresa con la entidad abierta de arriba, o en la forma 1.

### Qué rompe, y con qué código

Todo lo malformado rompe **al parsear** — al arrancar o al recargar, nunca en el request de un
consumidor— y **jamás degrada a «policy sin reglas»**, que es el fail-open que no deja rastro.

| Código | Cuándo |
|---|---|
| `columns-malformed` | `columns` (de la entidad o del spec) no es una lista |
| `column-rule-shape` · `-column` · `-claim` · `-action` | la regla no es objeto · sin `column` · sin `claim` · `action` ≠ `mask` |
| `column-rule-unknown-key` | clave de más: `{column, claim, action, if: …}` no es una regla condicional |
| `column-map-malformed` | el `columns` de un **dataset** no es un mapa atributo → columna |
| `column-unmapped` | la entidad protege un atributo que el dataset no mapea |
| `column-mapping-unknown` | el dataset mapea un atributo que la entidad no protege (typo) |
| `grant-columns-unsupported` | un dataset `grant: all` (sin entidad) mapea columnas |
| `grant-unsupported` | `grant` ≠ `all`, en una entidad o en un dataset |
| `entity-grant-and-governed` | la entidad declara `grant: all` **y** `governed_by` |
| `entity-open-dimensions` | un dataset mapea `dimensions` a una entidad abierta (no filtraría nada) |
| `unknown-column` (binder) | la columna enmascarada no existe en el schema del store |
| `unknown-claim` (binder) | el claim que habilita la columna no lo entrega el gate (enmascararía siempre, para todos) |

El **binder** liga las columnas enmascaradas igual que las de los predicados, y con el mismo error:
sin eso, un typo dejaría la regla apuntando a una columna inexistente, `maskRow` no inventa columnas
y el resultado sería **no enmascarar nada, en silencio**. Liga también el **claim** de la regla: ahí
el modo de falla es el opuesto —un claim inexistente enmascara siempre, para todos— y por eso pasaba
inadvertido; un typo que enmascara todo para todos merece el mismo `unknown-claim` que un predicado.
Corre **también sobre policies públicas**: `grant: all` con una columna sensible es el caso expuesto.

### Qué hace cada back-end

| Back-end | Comportamiento |
|---|---|
| **Fabric** | **Enmascara** (DDM: `ALTER COLUMN … ADD MASKED WITH (FUNCTION = 'default()')`, con su teardown idempotente), y la columna entra en `schemaDependencies`. **Brecha declarada**: DDM discrimina por *principal* (`UNMASK`) y Vergis no transporta al sujeto como principal, así que el `claim` de la regla queda **inerte** — sirve enmascarado a todos por igual (sobre-enmascaramiento, nunca fuga). Ver el comentario de `fabric.ts`, que además marca como **no medido** el caso en que el Service Principal tuviera `UNMASK` |
| **ClickHouse** | **No soporta** la capacidad y **rompe fail-closed** al compilar (`column-masking-unsupported`): un PI con regla de columna sobre este back-end **no se sirve** — la alternativa a la máscara no es servir en claro |

El valor de sustitución del **oráculo** es `MASK_VALUE` (`•••`); Fabric usa el `default()` del tipo,
que conserva el tipo de la columna en vez de castear a texto (mentimos el valor, jamás el esquema).

### Las dos consecuencias asumidas del diseño

No se esconden porque son parte del contrato, no defectos por corregir:

1. **La máscara miente el valor.** Es deliberado y es preferible a mentir el esquema: `•••` se lee
   como «no te corresponde», mientras que una columna ausente es indistinguible de un bug y cambia
   la **forma** del resultado por sujeto — el spec es authz-blind y describe columnas por nombre, así
   que ocultarlas produciría un PI distinto por persona sin que nadie lo haya diseñado.
2. **Un agregado sobre pocas filas puede revelar lo que la máscara esconde.** El agregado se permite;
   la máscara es de la celda. Razonar sobre cardinalidad —«un `SUM` de una fila revela el valor»—
   dentro del IR es exactamente el motor de inferencia que el charter prohíbe. **Ese hueco se cierra
   fuera del IR**: no sirviendo esa columna a ese sujeto, o no ofreciendo el agregado.

## Aseguramiento (doc 10 §9)

`tests/policy.test.ts`: front-end (parseo + negativos) · binder · codegen (SQL exacto + anti-inyección por nombre) · **las 8 propiedades RLS del arnés de Fase 0** · **property test** (800 casos aleatorios: `filas(codegen) == filas(referencia)`). La policy generada se cross-chequeó **viva** contra ClickHouse real (lab: `poc-clickhouse-rls/fase2-xcheck/`).

`tests/policy-diagnose.test.ts`: el diagnóstico se afirma como **teorema sobre el oráculo** —
`deniesAllRows(p, c) ⇒ applyPolicy(p, c, filas) === []` ∀ filas—, con 2000 casos aleatorios y un
**control de que el experimento ejercitó las dos ramas** (≥100 casos de cada lado): sin ese control,
una función que devolviera siempre `false` pasaría el teorema sin haber sido puesta en riesgo nunca.

## Fuera de alcance (por diseño)

Push-down (C) a la fuente — ahí enforce la fuente, no el compilador (doc 10 §1). ACLs por-registro, reglas temporales, aritmética de atributos — no caben en el IR (guardrail de auditabilidad).
