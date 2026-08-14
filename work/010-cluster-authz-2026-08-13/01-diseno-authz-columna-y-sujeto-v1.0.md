# El frente de autorización: columna, ancla, sujeto y mapa — v1.0

> **Qué es.** El diseño del frente que abren los issues **#163** (control por columna), **#164** (el
> allow-all anclado a una columna de datos), **#165** (¿el claim es valor o conjunto?) y **#159**
> (administración del mapa identidad→claims). Los cuatro nacieron del mismo terreno —la instancia
> Grupo Hijuelas— en dos días, y **no son cuatro pedidos: son cuatro caras de una sola pregunta** que
> el modelo de autorización todavía no responde.
>
> **Para quién.** Para el que ejecute cualquiera de los hitos **en frío**, sin esta conversación.
> Cada hito trae qué construir, contra qué verificarlo y qué NO hacer.
>
> **Estado de lo ya hecho** (2026-08-13, esta sesión): de #165 se cerraron §1 y §3; de #164, la
> mitigación mínima. Lo demás es diseño y espera su disparador o su medición.

---

## 1 · La pregunta única

Vergis autoriza en dos planos ortogonales, y lo dice bien: el **artefacto** (¿puede esta identidad
abrir el PI?) y el **dato** (¿qué filas ve adentro?). Los cuatro issues muestran que el segundo plano
está incompleto en las cuatro direcciones en que se puede estar incompleto:

| Issue | Pregunta | Qué falta |
|---|---|---|
| **#163** | ¿Qué se le puede servir al sujeto? | La granularidad: solo hay filas, no columnas |
| **#165** | ¿Qué **es** el sujeto? | El modelo: ¿su claim es un valor o un conjunto? |
| **#159** | ¿Quién decide qué claims tiene? | El control: el mapa no se administra desde la plataforma |
| **#164** | ¿Qué le cuesta al terreno tener autorización? | El acoplamiento: la RLS toma rehén columnas de negocio |

**El orden de ejecución sale de ahí, y no es el orden en que se abrieron.** #165 y #159 definen al
sujeto; #163 define qué se le sirve. Construir el control por columna antes de saber si un sujeto
tiene uno o varios nodos es construir sobre una definición pendiente — y el modo de falla es el peor:
no se cae, se propaga.

---

## 2 · #165 — el sujeto (PARCIALMENTE CERRADO)

### Lo decidido y construido (2026-08-13)

**El claim de un sujeto es un CONJUNTO, posiblemente unitario.** Declarado en `ir.ts` (tipo
`ClaimSet`), en `packages/policy/README.md` con la tabla de comportamiento por predicado, y sostenido
por lo que ya existía: el mapa acepta `string | string[]`, el enriquecimiento normaliza a lista,
`claimValues` devuelve siempre `string[]`, el codegen transporta con coma.

| Predicado | Con N valores |
|---|---|
| `in` | Unión |
| Jerárquico | Unión de los descendientes de los N nodos |
| `eq` | **Niega con N ≥ 2** — declara que el criterio no admite pertenencia múltiple |

**La negación de `eq` es correcta y no se toca.** Abrir sería over-grant; desempatar sería inferir
identidad. Lo que se construyó es que **deje de ser muda**: `packages/policy/src/diagnose.ts`
distingue `sin-claim` de `cardinalidad-eq`, y el server lo emite al armar el índice, deduplicado por
(usuario, tabla, causa). `deniesAllRows` se afirma como **teorema** sobre el evaluador de referencia,
con control de que ambas ramas se ejercitaron.

**`eq` no es «`in` con un solo valor».** Una política que quiera la unión ya tiene cómo decirlo. Que
la unión ocurra es decisión de la política, no del accidente de cuántos valores trajo el sujeto — que
es exactamente lo que pedía §2 del issue, y por eso §2 se considera cubierto por la declaración.

### Lo que queda abierto (§4 del issue) → va a #159

**Qué debe escribir el generador del mapa cuando la fuente autoritativa trae dos fichas activas.**
No se decide acá porque **no es una decisión del compilador sino del contrato del mapa**, y el mapa
es justo lo que #159 va a mover de archivo desplegado a superficie administrable. Decidirlo antes
sería fijar el contrato de una pieza que está por cambiar de casa.

Lo que sí queda dicho, para que #159 no lo re-abra desde cero:

- **«Las dos» tiene que ser expresable**, y hoy lo es: el mapa acepta lista. Con `in` produce la
  unión; con `eq` niega — y ahora la negación se explica.
- **«Ninguna» tiene que ser visible como tal**, no un hueco. Una identidad ausente del mapa y una
  identidad presente con claim vacío son hoy indistinguibles, y no deberían serlo: la primera es
  «nadie la reconcilió», la segunda es «se reconcilió y no resolvió».
- **Desempatar sigue prohibido.** Ninguna heurística por nombre, correo o antigüedad.

### El disparador de lo que falta

El issue lo dice y conviene conservarlo: **hoy esto no está ardiendo.** Ninguna política vigente de
la instancia de referencia ancla en el claim de área. La bomba está desactivada por el estado de la
configuración, no por el diseño — **se arma sola el día que alguien encienda RLS por área**. Ese es
el disparador de §4, no una fecha.

---

## 3 · #164 — el ancla del allow-all (MITIGADO, NO RESUELTO)

### El problema, en una línea

`grant: all` exige una columna de datos real para emitirse, y `WITH SCHEMABINDING` la convierte en
dependencia dura: mientras la security policy exista, esa columna no se puede alterar ni retirar.
**Cuál columna es un accidente** del aplicador. Medido: 34 `ADD FILTER PREDICATE` desplegados, con
`barcode`, `n_guia`, `anio_mes`, `especie`, `tipo_material`, `pais_destino` secuestradas.

### Lo construido (2026-08-13)

`FabricEnforcement.schemaDependencies` — el enforcement **declara** las columnas que ata. En una
policy gobernada la dependencia es semántica (la columna es el criterio); en `grant: all` es
andamiaje. Es el **camino 3** del issue en su forma mínima: la dependencia deja de ser un
descubrimiento —un `ALTER` rechazado en producción— y pasa a ser un dato legible **antes** del cambio.

**Esto no resuelve #164.** La dependencia sigue existiendo. Se hizo porque es lo único que se podía
hacer **sin medir**.

### La medición que destraba los caminos 1 y 2

**Pregunta exacta**: ¿acepta Fabric/Azure SQL un `ADD FILTER PREDICATE` cuya función inline **no
recibe ninguna columna** de la tabla? Y si no: ¿acepta una función cuyo único parámetro se alimenta
de una **constante** en vez de una columna?

- **Dónde**: el QA `vm-vergis-qa` contra el terreno `ws-arbol-qa`. No requiere PROD.
- **Forma**: crear una tabla desechable, intentar las dos variantes, y registrar el error exacto si
  las rechaza. **El error importa tanto como el éxito**: «sintaxis inválida» y «no soportado en este
  SKU» llevan a caminos distintos.
- **Control obligatorio**: la misma prueba con la forma ACTUAL (función con columna) debe pasar en
  el mismo terreno y la misma sesión. Sin ese control, un fallo de las variantes no distingue «Fabric
  no lo admite» de «el terreno estaba mal».

**Hasta que exista esa corrida, cualquier afirmación sobre los caminos 1 y 2 es conjetura**, incluida
la del propio issue («la documentación de T-SQL sugiere…»).

### Asimetría entre back-ends — a verificar de paso

En ClickHouse una policy pública **no genera** `CREATE ROW POLICY`, así que el problema puede
sencillamente no existir allá. Si se confirma, #164 no es un hueco del IR sino una asimetría del
back-end Fabric, y eso cambia dónde vive el arreglo.

---

## 4 · #163 — el control por columna (DISEÑO; NO SE CONSTRUYE TODAVÍA)

El issue enuncia cinco decisiones abiertas y pide no resolverlas ahí. Se resuelven acá, con su
fundamento — y con una decisión previa que las ordena.

### 4.0 · La decisión previa: esto NO se construye antes que #165 §4 y #159

El control por columna se declara **contra la entidad y para un sujeto**. Si el modelo del sujeto
todavía tiene un borde sin resolver (qué pasa con la doble pertenencia) y el mapa que lo alimenta
está por mudarse de casa, construir la granularidad fina encima es construir sobre arena. **Orden:
#165 §4 → #159 → #163.**

### 4.1 · ¿Ocultar o enmascarar? → **ENMASCARAR**

Ocultar cambia la **forma** del resultado por sujeto, y esa forma atraviesa todo el producto: un
spec es authz-blind y describe columnas por nombre; un render que recibe menos columnas de las que
el spec nombra produce un PI distinto por persona **sin que nadie lo haya diseñado**. Enmascarar
conserva la forma y sustituye el valor: el spec sigue siendo válido, el render es el mismo, y lo que
cambia es el dato — que es exactamente lo que la autorización debe cambiar.

**Consecuencia asumida**: enmascarar **miente el valor**. Es preferible a mentir el esquema, porque
un `•••` es legible como «no te corresponde» y una columna ausente es indistinguible de un bug.

**Portabilidad**: Fabric ofrece `MASKED WITH` nativo. ClickHouse no tiene equivalente directo, así
que el back-end ClickHouse **emitirá la máscara en la proyección** o declarará la capacidad como no
soportada — fail-closed: un back-end que no sabe enmascarar **no sirve** la entidad con columnas
declaradas sensibles, no la sirve en claro.

### 4.2 · ¿Qué hace un spec que pide una columna prohibida? → **SE DETECTA AL DESPLEGAR**

El issue nombra el tercer camino y dice que es el más caro. Es también el único correcto: fallar en
request rompe el PI de una persona sin diseño, y degradar produce calladamente un PI distinto por
sujeto. **Con la máscara, además, ninguna de las dos hace falta**: el spec pide la columna, la
recibe, y viene enmascarada. El conflicto deja de ser un error de request y pasa a ser lo que
siempre fue — **información de despliegue**: «este PI muestra una columna que N sujetos verán
enmascarada». Eso se reporta en la verificación de servibilidad por PI, junto al resto.

### 4.3 · ¿Y un agregado sobre una columna prohibida? → **EL AGREGADO SE PERMITE; LA MÁSCARA ES DE LA CELDA**

Y se declara por qué, porque es la respuesta que más incomoda: razonar sobre cardinalidad —«un `SUM`
de una fila revela el valor»— es **exactamente** el tipo de razonamiento que el guardrail de
auditabilidad no quiere dentro del IR. Meterlo convierte el vocabulario fijo en un motor de
inferencia, que es el «motor de authz disfrazado» que el charter nombra por su nombre.

**La consecuencia se acepta y se declara**: un agregado sobre pocas filas puede revelar el valor que
la máscara esconde. Quien necesite cerrar ese hueco lo cierra donde se puede razonar —no sirviendo
esa columna a ese sujeto, o no ofreciendo el agregado— y no dentro del IR.

### 4.4 · ¿Cómo lo ve Miranda? → **LA COLUMNA EXISTE Y SE NOMBRA; NO SE SONDEA**

Ocultar la existencia protege más y **miente sobre el terreno**, y un asistente de catálogo que
miente sobre el terreno es peor que uno limitado: envenena todo lo que se construya con lo que
describa. La columna se nombra, se declara **enmascarada para quien pregunta**, y no se sondea.
Coherente con 4.1: mentimos el valor, jamás el esquema.

### 4.5 · ¿Cómo se verifica? → **EL ORÁCULO CAMBIA DE TIPO, Y ESE ES EL HITO 1**

`applyPolicy` es hoy `rows.filter(...)`: devuelve las mismas columnas que recibió. Una regla de
columna cambia el **tipo de su salida** —de `Row[]` a `Row[]` con celdas sustituidas— y con él el
property test diferencial que sostiene todo el aseguramiento del compilador.

**No es detalle de implementación: es el oráculo, y se hace primero.** La firma pasa a
`applyPolicy(policy, claims, rows) → Row[]` donde cada celda de una columna enmascarada para esos
claims viene con el valor de sustitución. El property test existente **debe seguir pasando sin
cambios** para políticas sin reglas de columna: esa es la prueba de que la extensión es conservadora.

### 4.6 · Lo que NO se hace

- No se pide `MASKED WITH` como requerimiento: es **una** forma de cumplirlo.
- No se relaja el guardrail del IR. Si la única forma de expresar una regla de columna fuera abrir el
  vocabulario a condiciones arbitrarias, **la respuesta correcta es no hacerlo y decirlo**.
- No hay cifrado, tokenización ni gestión de claves.
- **No se enmascara «por si acaso»**: la ausencia de declaración no cambia nada. Una columna sin
  regla se comporta como hoy.

### Hitos de #163

| Hito | Qué | Cómo se verifica |
|---|---|---|
| **H1** | El oráculo: `applyPolicy` devuelve filas con celdas enmascaradas; IR gana la declaración de regla de columna (vocabulario **fijo**: columna × claim × acción `mask`) | El property test actual pasa **sin cambios** para políticas sin reglas de columna |
| **H2** | Back-end Fabric: `MASKED WITH` + su teardown; `schemaDependencies` incluye la columna enmascarada | Differential test contra el oráculo, como el resto del codegen |
| **H3** | Back-end ClickHouse: máscara en proyección **o** capacidad no soportada declarada, fail-closed | Un PI con regla de columna sobre un back-end que no la soporta **no se sirve** |
| **H4** | Superficie: la verificación por PI reporta «columna X enmascarada para N sujetos» al desplegar | Aparece en el reporte de servibilidad, no en el request |
| **H5** | Miranda: la columna se nombra, se declara enmascarada, no se sondea | El catálogo describe el terreno completo; el sondeo respeta la regla |

**Lo que NO está medido y hay que medir antes de H2**: el costo de enforcement por columna en Fabric,
y **cómo interactúa `MASKED WITH` con las vistas-contrato `SCHEMABINDING`** que la instancia ya usa.
El issue lo declara conjetura y sigue siéndolo.

---

## 5 · #159 — la administración del mapa (DISEÑO; ES EL SIGUIENTE)

El mapa `correo → claims` es **el trust-base sobre el que se aplica toda política**, y es hoy la
única pieza del gobierno que no se administra desde la plataforma: las políticas ya recargan en
caliente, el mapa no. Las cinco capacidades del issue (ver, editar, overrides declarados, recarga en
caliente, procedencia por entrada) se toman como están. Lo que este diseño agrega:

- **La procedencia es lo que hace revisable todo lo demás.** Sin distinguir «vino de la fuente
  autoritativa» de «lo inscribió un humano», la primera regeneración del mapa borra los overrides
  —que es literalmente el defecto que el issue reporta: una cuenta de operación que se cae cada vez—
  y nadie puede auditar después quién abrió qué.
- **Y es donde cae #165 §4.** Una entrada que la fuente trajo **ambigua** (dos fichas activas) es un
  tercer valor de procedencia, no un error: `autoritativa` · `override humano` · `autoritativa
  ambigua`. Con eso, «ninguna» deja de ser un hueco y pasa a ser un estado que la superficie muestra
  — que es lo que §4 pedía sin nombrarlo.
- **Recarga en caliente**: el contrato de arranque (`[hot-reload] activo · specs=… · policies=N ·
  gobierno-dominio=N`) debe incluir el mapa. Hoy no lo incluye, y por eso una corrección no surte
  efecto hasta reiniciar — **el acto que interrumpe el servicio**.
- **Lo que no se relaja nunca**: una identidad que no resuelve no se adivina. Queda sin claims y la
  política decide fail-closed. Esto es duro y la conveniencia de la UI no lo toca.

---

## 6 · Lo que este documento NO decide

- **El disparador de #163.** Hay diseño; no hay fecha. El driver real será una instancia que
  necesite servir un dominio con datos personales sin colapsar «este dominio es público» con «esta
  columna es sensible» — hoy resuelto con la herramienta más gruesa: **no cargar el dato**.
- **Nada que dependa de la medición contra Fabric** (§3 y H2 de §4): sin la corrida, es conjetura.
- **El orden entre #159 y el resto del roadmap.** Es una decisión de valor de negocio, y no la toma
  un diseño.

---

• *Diseño del cluster authz · 2026-08-13 · Generado con Wingworking*
