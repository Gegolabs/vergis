# Consola SQL — T-SQL libre sobre un Conector, acotado por la misma RLS que un PI

> **La promesa, y su límite en una frase:** la Consola te muestra **lo que Mira te mostraría a ti**.
> No es una consola de administración de la fuente, y no puede serlo sin dejar de cumplir esa
> promesa. Para administrar el almacén está el SQL endpoint de Fabric con la cuenta propia del
> ingeniero, que tiene su propia auditoría.

Issue de origen: [#306](https://github.com/Gegolabs/vergis/issues/306). Regla rectora, **MUST**:
*«la Consola acota, nunca amplía»*.

## ¿Qué es?

Una superficie de **Ingeniería**: se abre desde el menú del avatar, se elige un Conector registrado
(`VERGIS_CONNECTIONS`), se escribe T-SQL y se ve el resultset. Toda ejecución queda en un log
append-only con el actor real del gate.

Lo que el ingeniero ve son **sus filas** —exactamente las que vería en un PI para su identidad,
porque es la MISMA `SECURITY POLICY` sobre el MISMO `SESSION_CONTEXT`— y nada más.

## ¿Bajo qué identidad se ejecuta?

Bajo un **principal de consola propio de cada Conector**, declarado como sub-perfil `consola` del
perfil de conexión, con los claims del ingeniero inyectados en `SESSION_CONTEXT` **con
`@read_only = 1`**, sobre una **conexión dedicada que se cierra al terminar**.

Tres cosas que no son, y por qué:

- **No es la identidad del ingeniero.** En Vergis el sujeto llega al motor **solo** por
  `SESSION_CONTEXT`; darle un login SQL a cada persona sería cambiar la arquitectura de identidad del
  Producto, y nadie lo pidió.
- **No es el Service Principal del serving.** Ése es Admin de los workspaces de la instancia: bajo él
  un `SELECT` ad-hoc es bypass completo — podría `ALTER SECURITY POLICY … STATE = OFF`, leer sin
  máscara y escribir. Declarar un `consola` con el mismo `clientId` que el padre es **config rota** y
  el nodo lo rechaza al arrancar.
- **No hay fallback.** Un Conector sin sub-perfil `consola` simplemente **no se ofrece**. Ni «por
  ahora», ni «en dev».

`@read_only` es lo que impide que el texto del usuario reescriba sus propios claims: tras el prelude,
un `EXEC sp_set_session_context` sobre la misma clave **falla** en el motor (error 15664). Como la
clave queda clavada por toda la sesión, la conexión **no puede volver a un pool**: se abre por
ejecución y se cierra en `finally`, pase lo que pase.

## ¿Por qué es de solo lectura, y qué lo garantiza?

Lo garantiza el **permiso del principal**, medido antes de ofrecer el Conector. **Ninguna garantía
vive en un parser**, y decirlo vale más que proponerlo: una lista negra de palabras o un «detector de
`sp_set_session_context`» son coladores (`EXEC('DR'+'OP …')`, `sp_executesql`, `OPENROWSET`, vistas), y
lo peor que hacen no es fallar — es dar una sensación de seguridad que después alguien usa para
aflojar el gate que sí funciona.

## ¿Cuándo se ofrece un Conector? (el gate, y sus cuatro condiciones)

Se mide al arrancar y tras cada recarga de conexiones, **nunca en el request**. Cualquier medición
que no se pueda hacer ⇒ **no se ofrece**: un instrumento que no midió jamás se colapsa con «midió y
salió bien».

| Condición | Cómo se mide | Si falla |
|--|--|--|
| **(a)** El principal no puede escribir | `sys.fn_my_permissions(NULL,'DATABASE')` contra lista blanca (`CONNECT`, `SELECT`, `SHOWPLAN` y la familia `VIEW …`, que es toda de metadatos) | No se ofrece, con el permiso ofensor nombrado |
| **(b)** Toda tabla base está **cubierta** | Cubierta = tiene `SECURITY POLICY` **o** el principal de consola no puede leerla (ver «la segunda forma», abajo). El gobierno sale de `sys.tables` − `sys.security_policies` (el centinela de #238 se excluye: es instrumento, no dato) y **se pregunta bajo el principal de SERVING**: es una propiedad del terreno, y `sys.security_policies` está filtrada por permiso — el de consola lee cero filas con el terreno entero gobernado (#340) | No se ofrece, nombrando las tablas **sin cobertura** |
| **(b·permiso)** La segunda forma de cobertura | `HAS_PERMS_BY_NAME('<sch>.<tbl>','OBJECT','SELECT')` **bajo el principal de consola**, en **una sola consulta** y solo si hay tablas sin política. `NULL` o consulta que falla ⇒ **no cubre** | No se ofrece, con «no se pudo medir el permiso» |
| **(b·guarda)** El principal que sondea PUEDE ver el gobierno | Con tablas base y **cero** políticas visibles: `HAS_PERMS_BY_NAME` (`VIEW DEFINITION` de base · `VIEW ANY DEFINITION` de servidor). Ver al menos una política ya es prueba positiva y la guarda no se paga | No se ofrece, pero por **«no se pudo medir el gobierno»** — motivo distinto de «hay tablas sin política», porque la remediación es opuesta: conceder visibilidad de metadatos, no declarar políticas |
| **(c)** El principal no puede desenmascarar | Centinela `vergis_unmask_probe` leído bajo el principal de consola | No se ofrece |
| **(d)** El motor honra `@read_only` | Sonda con la clave REAL, en el MISMO batch que un `SELECT`, con control positivo | No se ofrece |

`GET /contrato` publica el veredicto y el motivo **por Conector**, para que el operador no tenga que
adivinar ni leer los logs del contenedor.

Nota medida: **`UNMASK` es un permiso de base**, así que (a) lo caza antes de que (c) llegue a
correr. Es defensa en profundidad, no redundancia — las dos condiciones siguen valiendo por separado.

## La segunda forma de cobertura: ¿por qué `DENY SELECT` y no una política `deny`?

Un almacén no es solo Silver. Tiene tablas que **el pipeline lee y la Consola no debe ver**:
`_migrations` (la lee el runner de migraciones), `_bak_*`, `raw_*` (las consume la ingesta). Exigirles
`SECURITY POLICY` a ellas también dejaba al almacén entero sin Consola — y el remedio obvio es peor
que la enfermedad.

**Porque la RLS es de FILAS y de TODOS; el `DENY` es de OBJETO y de UNO.** Una política de fila
`deny` sobre `_migrations` no distingue quién pregunta: se la aplica el motor a **todos** los
principales, incluido el runner de migraciones, que pasaría a ver **cero filas** y a re-aplicar
migraciones ya aplicadas **sobre producción**. `DENY SELECT ON dbo._migrations TO [<principal de
consola>]` afecta **solo** a ese principal; el pipeline ni se entera.

Por eso una tabla base queda cubierta de dos maneras, y la segunda es simplemente ésta: **lo que la
Consola no puede leer no puede filtrar**. Una tabla que su principal no puede abrir no es una fuga
que falte gobernar — es una tabla que no existe para ella.

**Medido en producción** (`wh_presupuesto`, 2026-09-22), con premisa y control negativo:

| Paso | Consola lee `_migrations` | Serving lee `_migrations` |
|--|--|--|
| **Premisa** (antes del `DENY`) | 1 | 1 |
| **Efecto** (`DENY` aceptado por Fabric) | 0 | 1 |

Y la lectura la rechaza **el motor** —error de permiso—, no un parser. Reproducido en el arnés T-SQL
local (`npm run lab:proof`, sección **C4d**) con los dos controles en la misma corrida: con el `DENY`
el Conector pasa; con el `REVOKE` vuelve a bloquear.

**Fail-closed sobre la sonda.** La comprobación corre bajo el principal de consola —tener o no
`SELECT` es una propiedad de **ése**, al revés que el gobierno, que es del terreno—, en **una sola
consulta por Conector** y **solo si hay tablas sin política**: con el terreno entero gobernado no se
paga. Si `HAS_PERMS_BY_NAME` devuelve `NULL` o la consulta falla, la tabla **no** cuenta como
cubierta y el motivo lo dice. *Un instrumento que no sabe reportar su propio fallo produce datos con
cara de verdad.*

**El motivo publica las tres poblaciones** —`N con política · M excluida(s) por permiso · K sin
cobertura`— y **solo K bloquea**. Un Conector **ofrecible** que apoya parte de su cobertura en el
`DENY` **también** lleva motivo: «se ofrece» y «se ofrece porque M tablas están excluidas por
permiso» son hechos distintos, y el segundo es el que un operador tiene que poder auditar en
`/contrato`.

**Y no se listan.** El árbol de esquema de `/consola/<ref>/esquema` omite las tablas excluidas por
permiso: no se ofrecen, no se muestran. Mostrar en el árbol lo que la ejecución va a rechazar es una
promesa que la ejecución no cumple.

## ¿Por qué un Conector con reglas de columna NO se ofrece?

Porque **bajo SQL libre, una columna enmascarada se infiere sin verse nunca**.

Esto está **medido**, no razonado (arnés T-SQL local, `npm run lab:proof`, sección C3, 2026-09-21).
Con un principal **sin** `UNMASK`, que lee `xxxx` en la proyección, estas cinco formas devolvieron el
mismo conteo que con `UNMASK` —o sea, el predicado se evaluó contra el **valor real**—:

| Sonda | Sin `UNMASK` | Con `UNMASK` |
|--|--|--|
| `WHERE rut = '<valor real>'` | 1 | 1 |
| `WHERE rut LIKE '33.%'` | 1 | 1 |
| `WHERE rut BETWEEN '20' AND '30'` | 1 | 1 |
| `WHERE rut > '30'` | 1 | 1 |
| `WHERE SUBSTRING(rut,1,2) = '22'` | 1 | 1 |

Y `ORDER BY rut` ordenó por el valor real en los dos casos. Sus tres controles: **de premisa** (la
proyección salía enmascarada), **positivo** (las mismas sondas con `UNMASK` discriminan) y
**negativo** (un prefijo que ninguna fila satisface da 0 bajo ambos).

Un PI no permite esto porque sus consultas son fijas; la Consola sí, por definición. **Ninguna
doctrina de `UNMASK` lo arregla**: es un límite del Dynamic Data Masking, y (c) —a quién se concede
`UNMASK`— es un problema distinto que no lo toca.

Por eso, mientras esto no cambie, **un Conector con `columnRules` no se ofrece, punto**. No se ofrece
«con advertencia»: *una advertencia sobre una fuga es una fuga con cartel*. Relajarlo —ofrecerlo
declarándolo, o exigirle a la instancia que quite las reglas de columna— es una decisión del dueño del
producto con esta corrida a la vista, no un flag ni un env.

## ¿Qué motor cubre, y por qué ClickHouse no?

**Solo `engine=fabric`.** En ClickHouse los claims viajan como settings de request por query-param, y
una `SELECT … SETTINGS vergis_claim_groups='x'` del usuario compite por **el mismo canal**: el motor
no distingue el setting del nodo del setting del texto. Está **medido** (banco efímero, 2026-09-21)
que un `SETTINGS PROFILE` con `CHANGEABLE_IN_READONLY` tampoco separa los orígenes.

El canal exclusivo del nodo **existe y está demostrado** —`CREATE USER <ing> SETTINGS readonly=1,
vergis_claim_g='a' READONLY` da un claim que el propio usuario no puede alterar—, así que ClickHouse
queda fuera de la v1 **por ALCANCE, no por límite del motor**: llegar ahí es rediseñar el transporte
(de un usuario data-plane único a un usuario por identidad), no encender un flag.

## ¿Cuáles son los límites de ejecución?

| Límite | Env | Default |
|--|--|--|
| Tope de espera por ejecución | `VERGIS_CONSOLA_TIMEOUT_MS` | `60000` |
| Tope de filas (corte por **streaming**, jamás envolviendo el SQL) | `VERGIS_CONSOLA_MAX_ROWS` | `5000` |
| Consultas en vuelo por identidad | — | `1` (lo que le da sentido a «cancelar») |
| **Consultas en vuelo en el nodo** | `VERGIS_CONSOLA_MAX_CONCURRENTES` | **`1` — una consulta a la vez** |

**«Una consulta a la vez» es requisito, no ajuste.** La Consola corre contra la misma capacidad de
producción de la que cuelgan los PIs, los almacenes y las ingestas: **compite con lo que está
sirviendo**, y la capacidad se paga por tiempo encendida — así que el problema es de servicio, no de
factura. Que el env exista es para que una instancia con capacidad holgada pueda subirlo **por
decisión de su operador**.

El tope de filas se corta por streaming y **nunca** envolviendo el SQL del usuario (`SELECT TOP N *
FROM (<sql>) q`): envolver rompe con multi-sentencia, CTEs y `ORDER BY`, y sería el parser que este
diseño rechaza.

## ¿Quién puede abrirla?

Scope = **admin de plataforma ∨ miembro del grupo** `VERGIS_CONSOLA_SCOPE_GROUP` (default
`consola-sql`). Es autorización de **acción** sobre una superficie de gestión, la misma familia que
`/admin` y `/miranda` — **no** es una política de datos.

- Sin scope: **403** en toda ruta `/consola*`, **sin revelar** si la capacidad está encendida.
- Con scope y sin Conector ofrecible: **503** con la razón, por Conector.
- Sin scope, la entrada **no aparece** en el menú del avatar.

**Los Conectores no se restringen por persona**: se ofrecen todos los que pasan el gate, y lo que cada
uno muestra lo decide la RLS. Un recorte de superficie no protege el dato —lo hacen (a)(b)(c)(d)— y la
autoridad es la política, no el PI.

## ¿Qué queda auditado?

`${VERGIS_OUT}/consola-audit.log`, append-only y hash-encadenado, archivo propio (no se comparte con
`admin-audit.log`: son familias distintas, con volúmenes y lectores distintos).

Una entrada `consola-inicio` al empezar —para que una caída a mitad de consulta deje rastro— y una
`consola-ejecucion` al terminar, **siempre**: éxito, error, timeout o cancelación. Lleva `actor` (el
email del **gate**, jamás un campo del request), el SQL íntegro, los **nombres** de los claims
inyectados —nunca sus valores, que son datos de la persona—, duración y desenlace.

La cadena se verifica **offline**: `npx tsx scripts/verify-audit-chain.ts`, que la recorre sobre las
líneas del archivo (`verifyChain()` del log no sirve acá: en modo `retain:false` no retiene nada).

## ¿Cómo se configura una instancia?

```jsonc
// VERGIS_CONNECTIONS
{
  "finanzas": {
    "server": "…datawarehouse.fabric.microsoft.com", "database": "wh_finanzas",
    "auth": "secret", "tenantId": "…", "clientId": "<SP de serving>", "clientSecret": "…",
    "consola": { "auth": "secret", "tenantId": "…", "clientId": "<SP de consola, rol Viewer>", "clientSecret": "…" }
  },
  "personas": { "server": "…", "database": "lh_personas", "auth": "…" }  // sin `consola` ⇒ no se ofrece
}
```

El sub-perfil `consola` **hereda** `server`/`database`/`port`: declarar los suyos es config rota (no
sería el mismo Conector). El swap de hot-reload de conexiones lo cubre, y el gate **re-verifica** tras
cada recarga.

```bash
VERGIS_CONSOLA_ENABLED=1
VERGIS_CONSOLA_SCOPE_GROUP=consola-sql   # el grupo se gestiona en Mira, no en AAD
```

## ¿Qué queda fuera de la v1?

Escritura (el policy store **no** conoce una política de escritura, y no se inventa una) · ClickHouse ·
gestión de Conectores, usuarios o políticas desde la Consola · editor con resaltado o autocompletado
(sin dependencia no hay uno decente: un `<textarea>` con árbol de esquema clicable cubre el MVP) ·
favoritos con nombre · `GO` (es del cliente `sqlcmd`, no del motor) · export server-side: CSV, JSON y
XLSX son **client-side**, sobre el resultset que ya está en la página — así el export hereda la
audiencia por construcción y **exporta lo que se vio**, truncado incluido.

---

• *Generado con Wingworking*
