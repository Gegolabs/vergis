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
| ¿La **vista de máscara** se puede consultar? | **No — falla siempre** (`Unsupported data type error`) | La columna no enmascarada de la MISMA vista sí pasa |
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

## Lo que este terreno NO hace, por decisión

- **No copia datos de ninguna instancia**, ni anonimizados. El arnés mide **formas**, no datos, y una
  copia arrastra responsabilidad sin aportar verificación.
- **No usa el tenant, la suscripción ni el service principal del cliente.** Si el terreno necesitara
  algo de ellos para funcionar, no estaría desconectado.
- **No se respalda: se recrea.** `fab:proof` parte de cero y es idempotente. Si no puede levantar el
  terreno desde nada, el script está incompleto — y eso es un defecto del script, no del terreno.

---

• *Generado con Wingworking*
