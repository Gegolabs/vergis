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
- **`binder.ts`** — `bindPolicy`: valida columna contra el schema del store y claim contra los del gate.
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

## Aseguramiento (doc 10 §9)

`tests/policy.test.ts`: front-end (parseo + negativos) · binder · codegen (SQL exacto + anti-inyección por nombre) · **las 8 propiedades RLS del arnés de Fase 0** · **property test** (800 casos aleatorios: `filas(codegen) == filas(referencia)`). La policy generada se cross-chequeó **viva** contra ClickHouse real (lab: `poc-clickhouse-rls/fase2-xcheck/`).

`tests/policy-diagnose.test.ts`: el diagnóstico se afirma como **teorema sobre el oráculo** —
`deniesAllRows(p, c) ⇒ applyPolicy(p, c, filas) === []` ∀ filas—, con 2000 casos aleatorios y un
**control de que el experimento ejercitó las dos ramas** (≥100 casos de cada lado): sin ese control,
una función que devolviera siempre `false` pasaría el teorema sin haber sido puesta en riesgo nunca.

## Fuera de alcance (por diseño)

Push-down (C) a la fuente — ahí enforce la fuente, no el compilador (doc 10 §1). ACLs por-registro, reglas temporales, aritmética de atributos — no caben en el IR (guardrail de auditabilidad).
