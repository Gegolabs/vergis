# Cluster 010 — el frente de autorización (columna · ancla · sujeto · mapa)

Sesión 2026-08-13, trabajo del pasivo con mandato. Los cuatro issues nacieron del mismo terreno
—la instancia Grupo Hijuelas— y son cuatro caras de una sola pregunta que el modelo de autorización
no responde todavía.

| Doc | Qué |
|---|---|
| [`01-diseno-authz-columna-y-sujeto-v1.0.md`](01-diseno-authz-columna-y-sujeto-v1.0.md) | El diseño del frente: #163 con sus cinco decisiones resueltas y sus 5 hitos, #164 con la medición que lo destraba, #165 (parcialmente cerrado) y #159 como el siguiente |

**Estado al cerrar la sesión:**

| Issue | Estado |
|---|---|
| #165 | **CERRADO** — §1 y §3 construidos (modelo declarado + diagnóstico de la negación); §2 cubierto por la declaración; §4 aterrizó en #159 como el tercer valor de procedencia |
| #159 | **CERRADO** — las cinco capacidades construidas: persistencia con procedencia, resolver desde el store, recarga en caliente, Administración y overrides que sobreviven a la reconciliación |
| #163 | **CERRADO** — nueve hitos, del oráculo a Miranda. **No corrido contra Fabric vivo**: lo verificado es el SQL emitido y sus emuladores contra el oráculo |
| #164 | **ABIERTO, y con razón** — mitigado (`schemaDependencies` vuelve legible la dependencia), no resuelto. Los caminos 1 y 2 dependen de una medición contra Fabric que exige encender el QA |

**Los nueve hitos de #163**, por si hay que retomar uno:

| | Qué | Dónde |
|---|---|---|
| H1 | El oráculo gana la regla de columna; el property test viejo pasa **sin modificarse** | `ir.ts` |
| H2 | Fabric `MASKED WITH` — cinturón que enmascara **igual para todos** (DDM discrimina por principal) | `fabric.ts` |
| H3 | ClickHouse: capacidad **no soportada**, fail-closed, con evidencia del código | `clickhouse.ts` |
| H4 | La declaración en el spec y en el store legacy — cerró el fail-open más caro | `frontend.ts`, `store.ts` |
| H5 | La forma canónica + el binder liga las columnas | `entities.ts`, `binder.ts` |
| H6 | **La vista que honra el claim** por request, con centinela tipado | `fabric.ts` |
| H7 | `entities[].grant: all` + `columns`: el caso que ORIGINA el issue | `entities.ts` |
| H8 | El gate de servibilidad reconoce la vista — tres legs, ninguna es el nombre | `server/engines/fabric.ts` |
| H9 | Miranda nombra la columna y no la sondea | `packages/miranda/`, `server/miranda.ts` |

**Orden de ejecución, y no fue el de apertura:** #165 y #159 definieron al sujeto; #163 definió qué
se le sirve. Se respetó.

**Lo que este frente NO puede afirmar**, y conviene que sobreviva al cierre: nada se corrió contra un
motor vivo. La vista de máscara solo discrimina de verdad si el Service Principal de serving tiene
`UNMASK` — si no lo tiene, los dos mecanismos componen hacia el lado seguro (sobre-enmascaran) y la
capacidad queda degradada a «esta columna no se sirve a nadie». Esa medición, con su control positivo
en la misma sesión, está en `PENDINGS.md` y va **antes** de desplegar.

---

• *Generado con Wingworking*
