# Terreno Fabric propio — el arnés que mide lo que solo Fabric contesta

> Workspace Fabric bajo control propio, **desconectado del cliente**, con datos **sintéticos** y
> capacidad **pausada por defecto**. Issue #186. **No reemplaza al arnés local**
> ([`README-tsql-lab.md`](README-tsql-lab.md)): lo complementa, y cada uno contesta cosas distintas.

## ¿Para qué existe?

El arnés local mide la **semántica T-SQL** —gratis, sin red, sin capacidad—. Lo que no puede medir es
el **SKU**: si Fabric acepta cada sentencia, qué ve un service principal real, cuánto cuesta el
enforcement. Sin este terreno, esas preguntas se respondían con el QA **del cliente**, o no se
respondían — y la Norma 7 dice que el experimento lo corre quien publica.

## ¿Cómo se corre?

```bash
export VERGIS_FAB_SUB=b9ce0759-1cf3-4be9-af83-149c926fd584   # suscripción ultraBASE
export FAB_SERVER="$(…)"                                      # ver RESOURCES.md
export FAB_TOKEN=$(az account get-access-token --subscription $VERGIS_FAB_SUB \
                     --resource https://database.windows.net/ --query accessToken -o tsv)

npm run fab:resume    # prende la capacidad (empieza a facturar)
npm run fab:proof     # la prueba
npm run fab:pause     # y a otra cosa — NO se deja prendida
npm run fab:state     # Paused | Active, para verificar
```

**`fab:pause` no es opcional.** Una capacidad olvidada encendida es la forma clásica de que esto se
cancele por factura. El costo es despreciable **por el modelo de ventana**, no por sí mismo.

Para responder la pregunta de #163 hace falta además el token del **service principal**:

```bash
export FAB_SP_TOKEN=$(curl -s -X POST \
  -d "client_id=$SP_APP_ID&client_secret=$SP_SECRET&scope=https%3A%2F%2Fdatabase.windows.net%2F.default&grant_type=client_credentials" \
  "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
```

Sin él, P5 **no se salta en verde**: declara que la pregunta quedó sin responder. Medir `UNMASK` con
la cuenta propia no contesta nada — un admin humano siempre lo tiene.

## ¿Cada cuánto se corre? — la cadencia, declarada

**Al cortar cada versión, ANTES de empujar el tag.** Ésa es la cadencia y no hay otra.

Se declara acá porque un arnés sin cadencia se pudre igual que uno sin gate, y **éste no puede tener
gate**: exige capacidad prendida, credenciales y plata, así que ningún CI lo va a correr. Lo que
reemplaza al gate no es la buena memoria de nadie — es que la regla esté escrita donde se lee al
cortar (`CHANGELOG.md` §«Antes de cortar») y que el propio arnés traiga su centinela (P10), que hace
ruidosa la ausencia de la precondición en vez de dejarla pasar en verde.

**El precedente que la fija:** el DDL del centinela de #238 se midió contra Fabric **veinte minutos
después** de empujar `v0.21.0`. Salió bien, y eso es exactamente lo que lo vuelve un mal precedente:
la versión ya estaba publicada cuando se supo. Publicar empieza en el tag, no en el aviso.

La ventana entera es **un solo comando de shell** —con la pausa en el `trap`— y cuesta del orden de
dos centavos. Entra bajo **POL-01** y se corre sin preguntar.

```bash
npm run fab:sql                                        # gratis: el SQL emitido, sin motor y sin gasto
npm run fab:resume && npm run fab:proof && npm run fab:pause
npm run fab:state                                      # y se verifica que quedó `Paused`
```

## ¿Qué contesta y qué no?

| | Arnés local (`lab:proof`) | Este terreno (`fab:proof`) |
|---|---|---|
| Semántica T-SQL — DDM, `UNMASK`, `SECURITY POLICY`, `SCHEMABINDING`, `SESSION_CONTEXT` | ✅ | — |
| ¿El **SKU** de Fabric acepta cada DDL que emitimos? | | ✅ |
| ¿La vista/artefacto **se puede consultar**, no solo crear? | | ✅ |
| Qué ve un **service principal** real, por rol | | ✅ |
| **Costo** de enforcement, plano de control, OneLake, jobs | | ✅ |
| ¿Cuesta plata correrlo? | no | sí (ventana de minutos) |

**Las dos asimetrías, que van en sentidos opuestos:**

- Del arnés **local**: un negativo refuta también para Fabric; un positivo **no** garantiza Fabric.
- De **este** terreno: un negativo es definitivo para Fabric; un positivo vale para **este SKU (F2)
  y este rol** — no para cualquier instancia.

## Los dos principios que no se negocian

**El DDL sale de `compileFabric`, nunca escrito a mano.** Un arnés con su propio SQL se mide a sí
mismo: pasaría en verde mientras el Producto emite otra cosa.

**El terreno levanta la MISMA forma que el arnés local** — misma política, mismas columnas, mismas
filas—, para que la única diferencia entre los dos bancos sea **el motor**. Un banco que además
difiere en el esquema mide dos cosas a la vez y no distingue cuál falló. La única divergencia
declarada: los tipos son `VARCHAR` con collation UTF-8, porque Fabric Warehouse no soporta
`NVARCHAR` — y es la forma que la instancia real usa.

## Lo que este terreno midió el primer día (2026-08-16)

Todo lo de acá salió de una corrida, no de una lectura del manual. La fecha importa: son respuestas
de **este SKU** en **este momento**, y Fabric se mueve.

| Pregunta | Respuesta medida | Control que la sostiene |
|---|---|---|
| ¿Acepta Fabric las 9 sentencias de `compileFabric`? | **Sí, las 9** | `sys.masked_columns` y `sys.security_policies` corroboran la instalación |
| ¿La **vista de máscara** se puede consultar? | **No — falla siempre** (`Unsupported data type error`). *Cierto de la forma de entonces; el rediseño de #197 la volvió consultable — ver la ventana del 18-ago abajo* | La columna no enmascarada de la MISMA vista sí pasa |
| ¿Por qué falla? | `SESSION_CONTEXT()` **dentro de un `CASE`** sobre un scan de tabla | Tres controles: `CASE` sin `SESSION_CONTEXT` pasa · `SESSION_CONTEXT` sin `CASE` con `FROM` tabla pasa · variable local + `CASE` pasa |
| ¿La row policy discrimina? | **Sí** | Sujeto con 2 grupos ve 2 filas; sujeto sin grupos ve 0 |
| ¿El SP tiene `UNMASK`? | **Depende del ROL del workspace**: `Member` ve el valor real, `Viewer` ve la máscara | Se cambió el rol en ambos sentidos con el mismo SP |

**El corolario que más pesa:** que Fabric **acepte** el DDL no significa que el artefacto **sirva**.
El `CREATE VIEW` pasa en verde y todo `SELECT` sobre ella falla. Un arnés que solo aplicara el setup
y mirara `sys` habría dado verde entero. Por eso P4 consulta, y consulta **con filas visibles**.

### Dos trampas del terreno, medidas y no deducidas

**1 · Revocar un rol no es inmediato; concederlo sí.** Al subir el SP de `Viewer` a `Member`, el
valor real apareció en la primera lectura (t+0s). Al bajarlo de `Member` a `Viewer`, **6,5 minutos de
sondeo continuo y el SP seguía viendo el valor real**. La máscara se observó recién después de
recrear tabla y política. **Cuál de las dos cosas destraba la revocación —el tiempo o el DDL— no
está medido.** Consecuencia práctica: tras cambiar un rol, **no se cree la primera lectura**; se
recrea el terreno o se verifica el veredicto contra la expectativa antes de citarlo.

**2 · El driver miente sobre DDL que sí se aplicó.** `mssql` puede devolver
`Failed to cancel request in 5000ms` sobre un `CREATE TABLE` que Fabric ejecutó. Por eso P0 no
confía en lo que devolvió el cliente: corrobora con `OBJECT_ID`.

**3 · `az fabric capacity resume` se cuelga.** El recurso queda `Active` y el CLI no vuelve. Verificar
con `npm run fab:state` en vez de esperar al comando.

## Lo que la ventana del 2026-08-18 midió (P6 y P7)

Corrida completa contra el SKU F2, capacidad encendida y pausada en la misma sesión. **Dos preguntas
que llevaban semanas trabadas quedaron respondidas, y una tercera sigue sin responder.**

### P6 (#197) · La vista de máscara SÍ es expresable en Fabric

| Candidata | ¿Acepta? | ¿Sirve? | ¿Discrimina? | Veredicto |
|---|---|---|---|---|
| **C1** · CTE escalar + `CROSS JOIN` | ✅ | ✅ | ✅ | **Viable** |
| **C2** · `CROSS APPLY (VALUES …)` | ✅ | ✅ | ✅ | **Viable** |
| **C3** · sin `CASE` (`NULLIF`/`IIF`) | ❌ | — | — | Descartada |

Con el claim `ve_pii` las vistas devuelven el RUT real; sin él, `***`. Los dos controles corrieron en
la misma sesión: el **positivo** (la sesión responde) y el **negativo** (la forma ACTUAL sigue
fallando, o sea que el diagnóstico de #197 sigue en pie y no cambió el motor bajo nuestros pies).

**El control de discriminación se agregó DESPUÉS de la primera corrida, y ésa es la lección.** La
primera pasada declaró C1 y C2 «viables» habiendo medido solo que la vista se crea y se consulta —
que es justamente el error que #197 vino a corregir, con otra cara. Una vista que se consulta pero
devuelve lo mismo con y sin el claim no protege nada y habría pasado el filtro. **«Consultable» no
es «sirve»; sirve es «discrimina».**

### P7 (#164) · La columna puede dejar de ser rehén

- `CREATE FUNCTION` **sin parámetro**: aceptado.
- `ADD FILTER PREDICATE` **sin argumento**: aceptado — la columna deja de ser rehén.
- **Y no es un deny silencioso**: con la policy instalada la tabla sigue sirviendo sus 2 filas.
  Cambiar un andamiaje por una policy que niega todo sería peor que el problema original.
- `sys.security_policies` corrobora: `is_enabled: true`, `is_schema_bound: true`.
- Variante (c), argumento **constante**: también aceptada — hay camino de respaldo.
- **Control positivo en la misma sesión**: la forma actual (función CON columna) se acepta.

## Lo que la ventana del 2026-08-18 (segunda) midió: el rediseño de #197, ya en el compilador

La ventana anterior dejó C1 y C2 declaradas viables **con SQL escrito a mano**. Esta corrió el SQL
que **emite `compileFabric`** tras cambiar el codegen a la forma C2 — que es la única medición que
autoriza a cerrar #197, porque entre el SQL de P6 y el emitido había una diferencia real y no
controlada: P6 casteaba el claim a `VARCHAR(8000)` y el compilador emite `NVARCHAR(MAX)`.

| Pregunta | Respuesta medida |
|---|---|
| ¿Fabric acepta las 9 sentencias con la vista C2? | **Sí, las 9** (P1) |
| ¿La vista **emitida** se puede consultar? | **Sí** — `[{"area":"Comercial","rut":"•••"},…]` (P4) |
| ¿**Discrimina** por claim? | **Sí** — con `ve_pii` devuelve el RUT real; sin él, el centinela (P4) |
| ¿El `NVARCHAR(MAX)` del `CAST` estorba? | **No** — el diagnóstico que lo aislaba no llegó a correr porque la vista sirvió |

**Lo que esto cierra y lo que no.** Cierra que la vista de máscara del Producto **sirve y protege**
en el SKU F2. No cierra P5: sigue sin medirse si el service principal de serving tiene `UNMASK`, y
mientras no se mida, lo que un SP `Viewer` vea por esta vista sigue siendo el DDM de la tabla.

### P8 (#164) · el allow-all emitido, y el control que decide

P7 midió la **forma** a mano; P8 aplica el `setupSQL` que sale de `compileFabric` tras el rediseño y
hace la pregunta que el issue plantea y que ninguna corrida había hecho:

| Pregunta | Respuesta medida |
|---|---|
| ¿Acepta el SKU las 4 sentencias del allow-all sin columna? | **Sí** |
| ¿Sigue sirviendo sus filas (no es deny mudo)? | **Sí**, 2 de 2 |
| Con la policy **instalada**, ¿se puede `ALTER` una columna de negocio? | **Sí — la columna NO es rehén** |
| ¿Qué declara `schemaDependencies`? | **`[]`** — el allow-all no ata nada |

El mismo control corrió antes en el arnés **local** (`lab:proof` §P3b) y dio lo mismo. Son los dos
motores que el back-end sirve.

### Lo que esta ventana NO respondió

**P5 (#163) — si el service principal de serving tiene `UNMASK`.** Falta `FAB_SP_TOKEN`: el secreto
del SP vive fuera del repo y no estaba en la máquina. El arnés lo declara y **no lo cuenta como
verde**, que es lo correcto — medir `UNMASK` con la cuenta de un admin humano no contesta nada,
porque un admin siempre lo tiene.

### Lo que sigue valiendo de la asimetría

Estos positivos valen para **este SKU (F2) y este rol**. No se generalizan a cualquier instancia: el
rol del workspace decide `UNMASK`, y eso ya está medido como variable (Member vs Viewer).

## Lo que este terreno NO hace, por decisión

- **No copia datos de ninguna instancia**, ni anonimizados. El arnés mide **formas**, no datos, y una
  copia arrastra responsabilidad sin aportar verificación.
- **No usa el tenant, la suscripción ni el service principal del cliente.** Si el terreno necesitara
  algo de ellos para funcionar, no estaría desconectado.
- **No se respalda: se recrea.** `fab:proof` parte de cero y es idempotente. Si no puede levantar el
  terreno desde nada, el script está incompleto — y eso es un defecto del script, no del terreno.

---

• *Generado con Wingworking*
