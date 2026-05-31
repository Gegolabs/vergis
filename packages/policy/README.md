# @vergis/policy — compilador de policy

Traduce la declaración **`audience.rls`** del spec (engine-agnóstica, doc 3 §6.1) al
**enforcement del motor** (doc 10). Es "el motor RLS como capability del Botler" (doc 8 §6)
en su parte de *compilación*: del QUÉ declarado (Instancia) al CÓMO del engine (Producto).

## Pipeline (un compilador clásico)

```
audience (spec)  ──front-end──▶  Policy IR  ──binder──▶  IR ligado  ──back-end──▶  enforcement
                  parseAudience                bindPolicy              compileClickHouse
```

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

## Aseguramiento (doc 10 §9)

`tests/policy.test.ts`: front-end (parseo + negativos) · binder · codegen (SQL exacto + anti-inyección por nombre) · **las 8 propiedades RLS del arnés de Fase 0** · **property test** (800 casos aleatorios: `filas(codegen) == filas(referencia)`). La policy generada se cross-chequeó **viva** contra ClickHouse real (lab: `poc-clickhouse-rls/fase2-xcheck/`).

## Fuera de alcance (por diseño)

Push-down (C) a la fuente — ahí enforce la fuente, no el compilador (doc 10 §1). ACLs por-registro, reglas temporales, aritmética de atributos — no caben en el IR (guardrail de auditabilidad).
