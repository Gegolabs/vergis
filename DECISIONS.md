# DECISIONS — decisiones tomadas en nombre de César (modo autónomo)

Registro exigido por la skill `procesamiento-autonomo`. Toda entrada es **revocable**:
el registro existe para que revertirla sea barato.

| Campo | Contenido |
|---|---|
| Sesión | 2026-08-06 · atención de los requests abiertos (work/002) · 2026-08-07 · solicitudes #138/#139 (work/003) · 2026-08-08 · ejecución de atendibles (work/005) · 2026-08-08 · fase 2 de #107 (work/006) · 2026-08-10 · trabajo del pasivo (`/ww:work run`) · 2026-08-14 · atención de #178 y corte de 0.16.0 · 2026-08-14 (noche) · arnés T-SQL local y corrección del plano de columna de #163 · 2026-08-16 · terreno Fabric propio (#186) y medición del plano de columna |

---

## D-31 · 2026-08-16 — El merge de lo confirmado deja de subir a César

- **Bifurcación**: `CLAUDE.md` decía «el merge es acto de César», y la sesión de hoy terminó pidiéndole el merge de #196 —un PR con typecheck, 2125 tests, build y CI verdes, corrido además contra el motor real—. Su corrección, textual: *«no quiero que me preguntes más por hacer merge a soluciones que fueron confirmadas resuelven un problema»*.
- **Decidido: el agente mergea lo confirmado**, y *confirmado* queda definido para que no se estire: gates verdes, CI verde y **evidencia medida** de que el problema quedó resuelto. Sin la medición no hay merge — mergear sin ella sería afirmar más de lo medido, que es lo que la Norma 7 persigue.
- **Por qué la línea queda ahí y no más allá**: lo que sube a César es lo que **es** decisión suya —gasto, comunicación saliente a un tercero, una bifurcación de diseño todavía viva, un PR ajeno—, no lo que solo es un clic. Es la misma economía que ya regía para el cierre de issues desde el 2026-08-14: el pasivo no se acumula por un trámite, y si al verlo considera que no correspondía, revierte.
- **Costo de revertir**: bajo. La norma vive en un párrafo de `CLAUDE.md`; volver atrás es restaurarlo. Los merges hechos bajo ella conservan su PR y su historia, y `git revert` sigue disponible.

## D-30 · 2026-08-14 — El plano de columna se corrige y se DIAGNOSTICA; la vista-contrato ajena no se toca

- **Bifurcación**: el arnés T-SQL local midió que el `ADD MASKED` de #163 no se instala si un objeto `SCHEMABINDING` referencia la columna — el caso de las vistas-contrato que la instancia real usa. Tres caminos sobre la mesa (los tres quedaron escritos en `NEXT.md` para que César decidiera): **(a)** enmascarar solo sobre la vista de máscara y sacar el DDM; **(b)** que el setup tire y recree la vista-contrato; **(c)** declarar la combinación no soportada y fallar ruidoso.
- **Decidido: (c) mejorado — se diagnostica con la remediación medida**, y se descartan (a) y (b) por razones distintas:
  - **(b) se descarta por autoridad, no por dificultad.** La vista-contrato es artefacto **de la instancia**: su forma es un contrato con sus consumidores, y puede tener índices. Que el Producto la tire y la recree —aunque sepa reconstruirla desde `sys.sql_modules`— es apropiarse de un objeto ajeno, y un fallo a mitad deja a la instancia sin su contrato. La frontera de `CLAUDE.md` aplica adentro del DDL, no solo al despliegue.
  - **(a) se descarta porque cambia la promesa de seguridad sin decirlo.** El DDM es la defensa en profundidad contra quien **esquiva** la vista de máscara; la vista honra al claim. Sacar el DDM deja la tabla base en claro para todo principal con `SELECT`. Que hoy sea **inerte** para el serving (medido: con `UNMASK` el principal ve el valor igual) no lo vuelve inútil — lo vuelve inútil *para ese principal*.
- **Y aparecieron dos defectos que ninguno de los tres caminos contemplaba**, porque nadie los había medido:
  - **El guard de idempotencia no guardaba.** T-SQL compila el batch entero antes de ejecutarlo y `DROP MASKED` se valida en compilación, así que `IF EXISTS … ALTER … DROP MASKED` **fallaba sobre toda columna sin máscara**. Como ese statement encabeza el setup (tira-y-recrea), **toda instalación nueva** del plano de columna fallaba en su primera sentencia. Corregido moviendo el `ALTER` dentro de `EXEC(...)`.
  - **No es incompatibilidad, es ORDEN.** Medido: la máscara sobre una columna libre se acepta, y la vista-contrato se crea después sobre la columna ya enmascarada. Lo imposible es alterar la columna con el objeto ya atado. Por eso el mensaje de error no dice «no soportado»: dice qué hacer, y esa salida **está corrida en el arnés** (P2c), no prometida.
- **El error del preflight es RAISERROR severidad 16 —falla ruidosa— y no un aviso**: el plano de FILA ya quedó instalado (va antes en `setupSQL`), así que lo que corta es exactamente el plano de columna. Un install parcial y silencioso es lo que produjo este defecto en primer lugar.
- **Lo que el propio arreglo casi reintroduce, y quedó como test de regresión**: la primera versión del preflight miraba también la dependencia de **objeto**, y como la security policy de fila que el mismo setup instala es `SCHEMABINDING`, se disparaba contra ella — habría roto toda instalación con reglas de columna. Lo destapó el arnés en su primera corrida, no una relectura.
- **Costo de revertir**: bajo y acotado a `packages/policy/src/fabric.ts` — dos funciones y una línea del ensamblado de `setupSQL`, con sus tests de SQL exacto. Nada desplegado: no hay versión publicada que lo lleve.

## D-29 · 2026-08-14 — El esquema del Producto admite Z: la corrección se publica sin capacidades nuevas

- **Bifurcación**: el preámbulo del `CHANGELOG` declaraba esquema **X.Y** (sin Z), pero 0.9.1 existía como precedente y la tabla de tags de 0.16.0 prometía que `:0.16` «flota al último patch» — dos afirmaciones incompatibles en el mismo archivo, introducidas por esta sesión. ¿Se admite la Z, o se retira la promesa del tag `0.16` y el fix viaja en la próxima Y?
- **Decidido por César** (2026-08-14): **se admite la Z** — corrección sin capacidad nueva. Queda coherente con 0.9.1, con la tabla de tags y con el `type=semver,pattern={{major}}.{{minor}}` del CI.
- **Por qué, y el caso que lo prueba**: el fix de #139 corrige un contrato que **inducía a operar mal** (declaraba `bootOnly` una clave recargable, o sea «reiniciá» cuando no hacía falta). Es exactamente el cambio que un operador querría adoptar **aislado**; sin Z, la única forma de dárselo era obligarlo a tomar una Y completa con capacidades que todavía no evaluó.
- **Se deja escrito lo que se iba a confundir**: la Z del Producto **no** es la Z de la Norma 3 de la Ley (que rige documentos y significa «solo cambió la forma»). Acá un cambio cosmético de código no se publica solo; lo que merece número propio es la corrección adoptable aislada.
- **Costo de revertir**: bajo — es el preámbulo del changelog más una línea de la lista de tags del CI. Lo que no se revierte gratis son las versiones ya publicadas con ese número.

## D-28 · 2026-08-14 — Acá se es el Producto: se publica la versión, no se despliega la instancia

- **Bifurcación**: la sesión cerró #178 y reportó como pendiente «falta el despliegue a la instancia». César lo corrigió: en este proyecto representamos el **Producto** y manipulamos el repo; no somos el usuario con acceso a la VM. ¿El entregable termina en el merge, en la versión publicada, o en el despliegue?
- **Decidido por César** (2026-08-14): **termina en la versión publicada, con su changelog y su aviso.** El descargue y el despliegue son del cliente —en este caso el agente que atiende A.R.B.O.L.— con su política de control de cambio. Canal de aviso **por ahora**: solo el GitHub Release; la lista de correos se define después.
- **Por qué no es una división de tareas**: un despliegue toca datos, disponibilidad y ventanas de un tercero. Esa autoridad no es de quien escribe el código. La norma queda en `CLAUDE.md` (se carga en toda sesión de este repo) y la cara al cliente en el preámbulo del `CHANGELOG.md`.
- **La condición material de la frontera, medida**: la frontera no existía técnicamente. `latest` se movía en **cada push a `main`** y los dos compose que gobiernan el deploy apuntan a ese tag (verificado en el repo del lab: `deploy/mira-vm/compose.yml:15` y `mira-vm-qa/compose.yml:11`) — así que un merge entraba en el siguiente recreate sin acto nuestro ni control de cambio suyo. Y no había alternativa: entre 0.15.0 y HEAD no existía versión que el operador pudiera **nombrar**. Corregido en 0.16.0: los tags que un consumidor pinnea los mueve un tag de git. *Alcance de lo verificado: el repo del lab, no el compose vivo en la VM.*
- **La política de tags se validó contra práctica de industria**, a pedido de César y no por criterio propio: `latest` reservado a releases estables con los builds de desarrollo en tag aparte, y el consumidor pinneando versión exacta o digest (ACR · Docker tagging best practices · Container Registry · Mend). De ahí salió el tag en cascada `0.16`, que la propuesta original no traía. Se dejó fuera `:0`: pre-1.0 el eje de ruptura es la Y del esquema X.Y, así que prometería compatibilidad que nadie sostuvo.
- **Lo que NO se revirtió**: la decisión de `9beeda8` (plantilla con tag móvil, sin digest) sigue en pie — es otra palanca, y con esta política el `:latest` de la plantilla por fin significa lo que ese commit quería que dijera.
- **Costo de revertir**: bajo en lo técnico (la lista de tags de `build.yml` es cinco líneas) y **nulo** en lo normativo: la frontera es una declaración de autoridad; se cambia diciéndolo.

## D-27 · 2026-08-13 — La vista de máscara y el DDM conviven, y la composición falla hacia el lado seguro

- **Bifurcación**: la vista de máscara (H6) honra el claim por request; el `MASKED WITH` (H2) enmascara igual para todos. Pero **la vista lee la columna base**: si el Service Principal del pool **no** tiene `UNMASK`, la rama «en claro» de la vista devuelve igual el default de DDM y **el sujeto CON el claim tampoco ve el valor**. ¿Se emiten los dos, o se retira el DDM sobre las columnas que la vista cubre?
- **Decidido**: **se emiten los dos.** La composición gana siempre el más restrictivo, así que el peor caso es **sobre-enmascarar**, nunca filtrar. Y cada uno cubre una topología distinta: la vista protege a quien se sirve por ella —el único camino que discrimina por sujeto—; el DDM protege a quien consulta **la tabla base**, que es el camino que queda si el spec no apunta a la vista.
- **El costo asumido, dicho**: si el SP no tiene `UNMASK`, la capacidad queda degradada a «esta columna no se sirve a nadie» — que es la herramienta gruesa de la que el issue se queja, pero **es segura**. Retirar el DDM para evitarlo cambiaría una degradación segura por una fuga posible, y esa no es una permuta que se haga sin medir.
- **La medición que lo destraba, y va antes de desplegar**: ¿el Service Principal de serving tiene `UNMASK`? Se mide en `vm-vergis-qa`, **en la misma sesión** que una consulta a la tabla sin vista como control positivo. Está en `PENDINGS.md` junto al gate de `MASKED WITH` × vistas-contrato.
- **Costo de revertir**: bajo — no emitir DDM sobre columnas cubiertas por la vista es una condición en el emisor.

## D-26 · 2026-08-13 — La apertura de fila sube a la ENTIDAD, para que el caso del issue se pueda decir

- **Bifurcación**: en la forma canónica un dataset `grant: all` no realiza entidad, así que no había atributo canónico que mapear y un `columns:` rompía con `grant-columns-unsupported`. La capacidad quedaba solo en la forma legacy — y con ella **el caso que origina #163**: la entidad `empleado`, abierta por decisión del cliente, con `rut` y nombre servibles a cualquier autenticado. ¿Se admite una regla inline en el dataset, o se mueve la apertura?
- **Decidido**: `entities[].grant: all` — **la apertura sube a la entidad** y convive con `columns`. Un solo sitio de autoría, la misma gramática, y `grant: all` conserva intacta su semántica de fila (apertura explícita y gobernada, con artefacto propio). La regla inline se descartó porque duplicar el sitio de autoría garantiza que las dos copias divierjan.
- **Evidencia**: la entidad ya era el sitio único del gobierno (`governed_by` ↔ `dimensions`) y ya sabía llevar reglas de columna sobre atributos canónicos; poner ahí la apertura reusa esa maquinaria entera. Y el default sigue siendo romper: una entidad sin gobierno **y** sin apertura sigue dando `entity-ungoverned`.
- **Costo de revertir**: medio — hay specs que podrían adoptar la forma. Mientras nadie la use, es una rama de parseo que se retira.

## D-25 · 2026-08-13 — Una regla de columna sobre ClickHouse tumba el arranque, y se le da SITIO

- **Bifurcación**: el back-end ClickHouse rechaza las reglas de columna (D-24). ¿Ese rechazo debe degradar a «ese PI no se sirve» —doctrina de #52— o tumbar el arranque del nodo?
- **Decidido**: **tumba el arranque**, sin doctrina nueva. Medido el precedente: en `computeBound`, la línea de al lado ya tumba el arranque cuando un dataset **no tiene política**. El fallo duro es la conducta establecida de ese motor y es fail-closed; la doctrina por-PI de #52 es de la verificación de servibilidad de **Fabric**, no del bootstrap de ClickHouse. Cambiarla acá habría sido inventar una excepción para el caso nuevo.
- **Lo que sí faltaba**: el **sitio**. El error del compilador llegaba sin nombrar el dataset, y el sitio es la mitad del diagnóstico. Se envuelve agregando el nombre y **conservando la causa original entera** (`cause`), con un control que fija que el envoltorio no se traga los errores que ya existían.
- **Costo de revertir**: nulo — es un `try/catch` que agrega contexto.

## D-24 · 2026-08-13 — ClickHouse declara la máscara NO SOPORTADA en vez de fingirla

- **Bifurcación** (§4.1 del diseño la dejaba abierta): ¿el back-end ClickHouse enmascara en la proyección, o declara la capacidad no soportada?
- **Decidido**: **no soportada, fail-closed al compilar**, con evidencia del propio código: el enforcement emite **solo** `CREATE ROW POLICY … USING <expr>`, que es un **predicado booleano por fila** —decide si la fila pasa, no qué valor lleva la celda—; la proyección **no la escribe el compilador** (`execute-sql-ch.ts` manda el `SELECT` del consumidor verbatim); y el aplicador solo aplica `rowPolicySQL`. Lo más cercano del motor, `GRANT SELECT(col)`, **retira** la columna: cambiaría la forma del resultado, que es justo lo que §4.1 descarta.
- **La consecuencia se acepta**: un PI con columna sensible sobre ClickHouse **no se sirve**. Es estrictamente mejor que la alternativa —servirlo en claro— y la remediación del error lo dice de frente para que nadie «arregle» el problema retirando la regla.
- **Lo que NO está medido, y va dicho**: que ClickHouse carezca de un equivalente de `MASKED WITH` no se corroboró contra un motor vivo. Lo medido, que es lo que sostiene la decisión, es que **este back-end no controla la proyección** — y eso es del código de este repo.
- **Costo de revertir**: bajo — es un gate en el compilador.

## D-23 · 2026-08-13 — El valor de máscara es del BACK-END; el oráculo conserva un centinela

- **Bifurcación**: el hito 1 fijó `MASK_VALUE = '•••'`, pero Fabric `MASKED WITH` devuelve el default **del tipo** (`0` en `INT`, `XXXX` en texto). El differential test chocaría. Las dos salidas obvias son malas: un valor de máscara por tipo convierte la constante en función y contamina el IR con tipos SQL; castear la columna a texto **cambia el esquema**, que §4.1 prohíbe.
- **Decidido**: **el valor de máscara pertenece al back-end; el IR conserva `•••` como centinela canónico, y cada emulador normaliza a centinela** lo que su motor produce antes de comparar. Así hay un solo oráculo, cada motor enmascara nativamente, y el esquema no se toca. El differential test afirma la **posición** de la máscara, jamás su contenido.
- **Costo de revertir**: bajo — la normalización vive en los emuladores, no en el SQL emitido.

## D-22 · 2026-08-13 — Los specs del canon NO se migran: se citan

- **Bifurcación**: `TODO.md` y el README declaraban pendiente «migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/`». ¿Se migran, o la premisa cambió?
- **La premisa re-derivada contra el terreno**: **no existen archivos-spec sueltos que mover**. Lo normativo vive dentro del **libro publicado** *AgencyDomains · Arquitectura del Mundo Agentivo* (v1.0, agosto 2026, agencydomains.org). Buscar «contrato Botler» o «spec Mira» como documentos en ese repo no devuelve nada: la migración estaba enunciada sobre artefactos que no existen con esa forma.
- **Decidido**: **no se migran; se citan.** Dos razones, y la primera es un hecho verificable, no una preferencia:
  1. **Las licencias no mezclan.** El libro es **GNU FDL v1.3**; este repo es **AGPL-3.0-or-later**, y la FDL no es compatible con la GPL. Copiar el texto normativo acá volvería una parte del árbol no redistribuible bajo su propia licencia — un defecto que solo aparecería el día que alguien redistribuyera.
  2. **Un spec con dos casas driftea**, y la copia siempre pierde porque es la que nadie relee. Este proyecto ya pagó esa factura: la línea del port a Go en `TODO.md` era un duplicado de una decisión del ADR-001 y envejeció peor que su fuente.
- **Hecho en su lugar**: `docs/canon.md` — dónde vive el canon, qué edición se cita, por qué no se copia, qué queda en `docs/` (lo verdadero de ESTA implementación), y la regla ante desacuerdo: el canon manda sobre *qué es* un Botler/Mira/DSL, el repo manda sobre *qué hace* esta implementación. Más el camino si algún día hace falta un fragmento in-tree: relicenciamiento explícito del autor (César tiene el copyright de ambas obras) registrado en un ADR — un acto, no un copy-paste.
- **Costo de revertir**: nulo — migrar sigue siendo posible el día que exista el acto de licencia; lo que se retiró fue una promesa que el README hacía sin poder cumplir.

## D-21 · 2026-08-13 — El aislamiento del render Vega: se cierra la E/S, NO se construye el subproceso

- **Bifurcación**: el roadmap pide «aislamiento del render Vega en **subproceso sin red ni filesystem**». ¿Se construye el subproceso, o se ataca el vector por otra vía?
- **La medición que decidió** (2026-08-13, en esta máquina, Node v22.22.3 — el mismo mayor que corre en la imagen, `node:22-slim`): el **permission model de Node 22 NO cubre la red**. Con `--experimental-permission --allow-fs-read=<dir>`: lectura fuera de la lista `ERR_ACCESS_DENIED` ✓, `child_process` `ERR_ACCESS_DENIED` ✓, y **`net.connect` a un host externo CONECTÓ**. O sea el subproceso entregaría *la mitad* del enunciado, y a cambio mete un pool de procesos en el camino caliente del render.
- **Corrección de instrumento, que casi produce el hallazgo contrario**: las primeras corridas fallaban al arrancar incluso con `node -e`, y parecía que el permission model rompía todo. Era el `NODE_OPTIONS` de esta terminal inyectando un `--require`. Con `env -u NODE_OPTIONS` el modelo funciona. **El instrumento medía el entorno, no el fenómeno.**
- **Decidido**: cerrar el vector **donde está**, en dos capas dentro del proceso, y no construir el subproceso. El vector real es que Vega sabe cargar datos sola (`data.url`, por red o `file://`) y los specs de Vergis traen los datos ya resueltos: ese camino no debe usarse nunca. (1) **Gate declarativo** — un spec con `url` se rechaza antes de llegar a Vega, ruidosamente. (2) **Loader que niega** toda E/S, como red de seguridad.
- **Por qué DOS capas y no solo el loader — medido, no supuesto**: con un servidor HTTP local contando hits, el loader por defecto **hace el fetch** (`hits=1`); el loader que niega lo evita (`hits=0`) **pero Vega se traga el error y rinde un gráfico vacío**, sin excepción. Protección silenciosa = PI degradado en silencio, que esta plataforma trata como defecto en todas las demás capas.
- **Lo que queda sin cubrir, dicho**: un exploit de Vega que haga E/S **sin pasar por su loader** (p. ej. por una dependencia transitiva) no lo detiene ninguna de las dos capas. Esa es la parte que un subproceso sí cubriría, y el día que exista un driver, la fs se cierra con el permission model y **la red hay que cerrarla en la red del contenedor**, no en Node. Queda escrito en el roadmap.
- **Costo de revertir**: bajo — dos piezas locales en `render-chart.ts`; quitarlas restaura el comportamiento anterior. El subproceso sigue disponible como camino, ahora con su medición hecha.

## D-20 · 2026-08-13 — El diagnóstico de #165 NO esconde el PI: lo explica

- **Bifurcación**: `canAccess` deja ver un PI si el sujeto trae **algún** valor del claim. Con `op: eq` y un claim de dos valores, la política niega **todas** las filas: el PI aparece en el índice y se abre vacío. ¿Se corrige la visibilidad (esconderlo, que es la dirección fail-closed) o se deja como está y se agrega el diagnóstico?
- **Decidido**: **la visibilidad no se toca; se agrega la explicación**. Esconderlo cambia una falla muda por otra —el sujeto pasa de «lo abro y está vacío» a «ya no está», igual de indistinguible de «no tengo permiso»— y encima destruye la única pista que tenía el operador. El issue pide explícitamente que el fail-closed no se toque; lo que faltaba no era ocultar mejor sino **poder decir cuál de las tres cosas pasó**.
- **Dónde vive, y por qué importa**: en `packages/policy/src/diagnose.ts`, junto al evaluador de referencia, **no** en el server. La explicación de una negación es semántica del IR: en el canal de serving cada back-end tendría su propia versión de «por qué no ves nada» y divergirían en la primera corrección. Además es función de `(policy, claims)` sin tocar filas — así vale igual en push-down, donde las filas no pasan por este proceso.
- **Lo que lo hace afirmable**: `deniesAllRows` se prueba como **teorema** contra el oráculo (2000 casos: si dice que niega todo, `applyPolicy` devuelve `[]`), con un **control de que las dos ramas se ejercitaron** (≥100 de cada lado) — sin él, una función que devolviera siempre `false` habría «pasado» el teorema sin ser puesta en riesgo jamás.
- **Costo de revertir**: bajo y aislado — el módulo es aditivo y nadie depende de él para decidir; quitar la llamada en `indexReports` apaga la línea del log sin tocar enforcement.

## D-19 · 2026-08-10 — La marca queda sin tocar (gasto), y se dice qué falta

> **SUPERADA 2026-08-13 por decisión de César: no se registra nada.** Esta entrada dejó la marca
> en su mesa; él la bajó de la mesa. La decisión de fondo queda cerrada en `TODO.md`; esto se
> conserva porque registra *por qué* el agente no la tomó — el límite del mandato, que sigue vigente.

- **Bifurcación**: la marca «Vergis» (y «Custos»/«Miranda») sigue diferida por César desde el 2026-08-08, con estado registral sin verificar. Con mandato amplio: ¿levantar el memo de disponibilidad, iniciar algo, o dejarlo?
- **Decidido**: **no se ejecuta nada**, y no por criterio sino por autoridad — registrar una marca **gasta plata** y compromete a Gegolabs frente a un registro público. Es de la familia que el mandato explícitamente no cubre. Tampoco se levanta el memo de disponibilidad: su valor entero está en consultar INAPI (y equivalentes) con datos reales, y una búsqueda no autoritativa presentada como memo sería justo el tipo de artefacto que la Norma 6 prohíbe — una conjetura con cara de dato que decide por quien la lea.
- **Lo que sí queda dicho**: el riesgo es asimétrico y no cambió. El registro temprano es barato; la ausencia es **irreversible** si otro registra primero. Sigue en `TODO.md` como decisión suya.
- **Costo de revertir**: nulo — no se hizo nada.

## D-18 · 2026-08-10 — El borrador de `CONTRIBUTING.md` se redacta, pero se deja INACTIVO

- **Bifurcación**: el diseño `004/11` §D5 (aprobada) manda redactar `CONTRIBUTING.md` con DCO + cláusula de relicencia marcada como sujeta a revisión legal; `TODO.md` prohíbe publicarlo sin revisión de César o de un abogado. ¿Se escribe como `CONTRIBUTING.md` confiando en el marcador HTML, o de otro modo?
- **Decidido**: se escribe como **`CONTRIBUTING.draft.md`**. Un comentario HTML no detiene nada: GitHub muestra `CONTRIBUTING.md` a todo el que abre un issue o un PR, y en ese instante la cláusula empieza a **obligar a terceros** — que es exactamente lo que la revisión pendiente debe autorizar. Con el nombre en `.draft.md` el trabajo queda hecho y el acto de publicar se reduce a un `git mv`, que es de César.
- **Contenido**: DCO 1.1 por `Signed-off-by`, cláusula de licencia de contribución con **su porqué dicho de frente** (por qué un DCO a secas no basta para el dual licensing, y que no se pide cesión de copyright), gates del CI, presupuesto de dependencias cero en `botler`/`policy`, y canal privado de seguridad. Dos huecos marcados en el texto: la redacción legal exacta y la dirección de contacto (sin confirmar).
- **Costo de revertir**: nulo — borrar un archivo que no está activo.

## D-17 · 2026-08-10 — #111 (rúbrica de convenciones) NO se cabla: espera su disparador

- **Bifurcación**: el H1 (sembrar el catálogo en `rubric/`) ya está mergeado (#147). ¿Se cabla el H2 —montar `convenciones.md` en el prompt de Miranda— ahora que hay mandato, o se respeta el disparador «≥2 casos aplicados» que el propio diseño declaró?
- **Decidido**: **se respeta el disparador**. Cablear ahora sería construir contra un catálogo de 4 convenciones sin uso medido — exactamente el «folclore» que el diseño combatió al volver el disparador medible (`grep -c` sobre las líneas `- caso …` del ledger). El mandato delega el juicio operativo; no convierte en atendible lo que está diferido por su propia condición.
- **Costo de revertir**: nulo — cablear sigue siendo el camino previsto el día que el ledger llegue a 2 casos.

## D-16 · 2026-08-10 — #138 se cierra con mandato de César

- **Bifurcación**: las tres piezas de #138 están atendidas (la 1 subsumida por #139·N1, la 3 medida y corregida en #140, la 2 implementada en #151). El issue quedaba «pagado, esperando finiquito». ¿Cerrarlo o dejarlo a César?
- **Decidido**: **cerrarlo**, con mandato explícito de César en esta sesión. La regla dura «el issue jamás se cierra solo» protege al **tercero** que lo abrió; acá el autor es el principal y él delegó la firma. Se cierra con comentario que deja el rastro de por qué cada pieza está saldada y qué queda diferido con disparador (fases 2-3 de config recargable).
- **Costo de revertir**: nulo — reabrir un issue es un clic.

## D-15 · 2026-08-10 — Se corta 0.15.0 (CHANGELOG + version + tag)

- **Bifurcación**: 21 PRs (#140-#160) sin entrada ni tag desde el deploy 0.14.0. El corte de versión venía marcado como decisión de César (precedente D-05). Con mandato: ¿0.15.0, o 1.0.0 dado el peso del tren?
- **Decidido**: **0.15.0**. La convención declarada en el propio CHANGELOG es explícita — «Y sube con cada conjunto de capacidades nuevas del DSL/runtime; **X se reserva para el primer release estable**». Nada en este tren declara estabilidad de contrato; el fix de #142 apunta en contra (la superficie de Miranda todavía estaba encontrando huecos de autorización).
- **Costo de revertir**: bajo — el tag se re-corta; nada desplegado hasta el paso siguiente.

## D-14 · 2026-08-10 — La baja del port a Go de `TODO.md` (y el delta que la funda)

- **Bifurcación**: César pidió detalle para evaluar si dar de baja el port del kernel a Go. ¿Se descarta el port, se deja el pendiente, o se hace otra cosa?
- **Decidido** (mandato explícito de César, «baja el port a Go»): **no se descarta el port — se retira el duplicado**. La decisión ya vivía en ADR-001 §Decisión·2; la línea de `TODO.md` la repetía con menos matiz y **había quedado falsa**: ADR-002 catalogó `packages/policy` como pieza abierta prioridad 1, con lo que «Custos como producto standalone» dejó de ser driver de ingreso. El ADR gana un delta con el reencuadre, los disparadores vivos (embedding, librería/WASM — ninguno con demanda) y la contra-consideración del Motor L (#113·09), etiquetada como leída-no-medida.
- **Colateral**: la cifra «2.100 iteraciones de property testing» del ADR-001 **no se reproduce** — lo medido es 800+800 = 1.600 (2.400 aserciones). Corregida con nota visible. La conclusión del ADR no se cae; la cifra era carga y estaba mal.
- **Informe**: `work/007-informe-port-go-2026-08-10/01-informe-baja-port-go-v1.0.md` (+ PDF en `export/`).
- **Costo de revertir**: nulo — reponer una línea en `TODO.md`. El port sigue disponible con sus disparadores sellados.

## D-13 · 2026-08-10 — Se bendice el import directo a módulos-hoja de `@vergis/capabilities`

- **Bifurcación**: pendiente abierto desde el 07 (`VERGIS_VERSION` importado por ruta relativa en `server/contract.ts`): ¿re-exportar en el índice del package, o bendecir el import directo a módulos-hoja?
- **Decidido**: **bendecir el import directo**, con dos requisitos — el módulo-hoja no tiene imports propios, y el import lleva su porqué escrito al lado. Lo que inclinó la balanza: este mismo lote produjo un segundo caso con la razón idéntica (`server/pdf.ts` → `table-runtime`), y la razón es dura, no de gusto: entrar por el índice arrastra vega/mssql a tests de módulos que son puros por contrato. Dos casos con la misma causa dejan de ser excepción.
- **Costo de revertir**: bajo — añadir los re-exports al índice y cambiar 2 líneas de import.

## D-12 · 2026-08-10 — Versiones de GitHub Actions elegidas aplicando el cooldown del propio proyecto

- **Bifurcación**: el pendiente decía «subir `checkout`/`setup-node` a v5». Al medir, la vigente es **v7** y hay una v46.2.2 recién salida del action de Renovate. ¿Se sigue la letra del pendiente, se toma lo último, o se aplica el criterio del proyecto?
- **Decidido**: **aplicar el `minimumReleaseAge` de 14 días del propio `renovate.json`** como criterio de selección. `checkout@v7` (publicada 07-20) y `setup-node@v7` (07-14) lo cumplen; para el action de Renovate se eligió **v46.1.21** (07-27) descartando v46.2.2/v46.2.1/v46.2.0 por tener 1/8/13 días. El arnés que hace cumplir el cooldown no se salta el cooldown.
- **No tocadas a mano**: las `docker/*` del build — las propondrá Renovate con su changelog, que es exactamente para lo que se encendió.
- **Costo de revertir**: bajo — son líneas de `uses:`; el CI valida el cambio en el mismo push.

## D-11 · 2026-08-10 — Renovate corre SELF-HOSTED en el CI, no como GitHub App

- **Bifurcación**: `renovate.json` existe desde el 2026-06-11 pero es **inerte** sin la App instalada, e instalarla exige consentimiento OAuth del owner de la org (acción humana no automatizable). Opciones: (a) Renovate self-hosted por GitHub Actions, (b) migrar a Dependabot nativo, (c) seguir esperando la instalación, (d) nada.
- **Decidido** (César eligió A al presentarle las cuatro): **(a) self-hosted** — `.github/workflows/renovate.yml`, semanal + `workflow_dispatch`. Conserva el `renovate.json` **tal cual**, sin traducir nada: el cooldown de 14 días, `osvVulnerabilityAlerts` y el pinning por digest siguen siendo los ya razonados. Dependabot habría exigido reescribir la config y su pinning de Actions es más limitado.
- **Sub-decisión — fail-closed**: sin el secret `RENOVATE_TOKEN` el workflow **falla en rojo** en vez de saltarse el trabajo. Misma doctrina que #117: un control que no corre tiene que distinguirse de un control que corrió y no encontró nada. Un scheduled run rojo ES la señal de que el cooldown no está activo.
- **También**: `RENOVATE_REQUIRE_CONFIG=required` — sin config en el repo, aborta; los defaults de Renovate **no** traen el cooldown, que es su razón de ser acá.
- **Hand-off**: crear el PAT y guardarlo como secret. Es lo único que queda, y es de César.
- **Costo de revertir**: nulo — borrar un archivo de workflow.

## D-10 · 2026-08-08 — Deltas de arquitectura del plan 006 sobre el diseño de la fase 2 de #107

- **Bifurcación**: el hallazgo del hito cero (el motor normaliza el payload: `""→null`, re-serialización) obliga a canonicalizar antes de comparar (refinamiento de D7, sellado en #107). ¿Dónde vive la canonicalización y cómo se reparte sin romper el paralelismo de la Ola 1 (H1∥H2∥H3)?
- **Decidido** (Δ1-Δ5 del plan `work/006-cluster-107-f2-publicacion/00-plan-v1.0.md`): (Δ1) módulo `definition-canonical.ts` en territorio H2; el sha del render, del ledger y del read-back es UNO, el canónico; lo no medido (payloads no-JSON) NO se normaliza — queda byte-a-byte con conjetura etiquetada. (Δ2) `derivePublishPlan` puro sobre shas — quien canonicaliza es el flujo admin (H4); evita dependencias H3→H1/H2 dentro de la ola. (Δ3) tipos por tipado estructural, sin imports cruzados en la Ola 1. (Δ4) `index.ts` único cruce declarado; lo resuelve el orquestador. (Δ5) `VERGIS_JOB_TEMPLATES` nace solo-arranque, FUERA de `RELOADABLE_SLICES` — la recargabilidad es de las fases 2-3 de #138·2, que esperan a César.
- **Costo de revertir**: bajo — Δ1/Δ2/Δ3 son cortes de módulo (mover una función es un refactor local); Δ5 es agregar una entrada a la tabla de slices cuando César apruebe las fases siguientes.

## D-09 · 2026-08-08 — Correr la sonda del hito cero de #107 contra el tenant real (plantación)

- **Bifurcación**: el hito cero de #107 F2 exige un experimento que ESCRIBE en el tenant (crea y borra un item). ¿Correrlo contra workspace real o sandbox, y con qué credencial?
- **Decidido** (César, go operativo en sesión): workspace **real** de plantación (`1d331022…`, D12), credencial del SP del intake (D9 default), corrida DENTRO del contenedor de la VM para no extraer el secreto a local (Norma 5). Ejecutada dos veces (reproducible), cero residuo.
- **Resultado**: **el SP puede autorar** (crear 201, agendar 201, borrar 200; controles A/A2 verdes). El exit 6 fue normalización del motor (`""→null` + pretty-print), no falta de persistencia — caracterizado. Refinamiento revelado para D7 (comparar canonicalizado, no por bytes). Sellado en #107.
- **Costo de revertir**: nulo — fue una medición idempotente (crea+borra); no dejó estado en el tenant.

## D-08 · 2026-08-08 — Semántica del guard de pertenencia de Miranda (frente F1 del cluster 005)

- **Bifurcación**: al diseñar el fix de las 5 rutas sin check de dueño: (a) ¿403 honesto o 404 que oculta la existencia?; (b) ¿qué pasa con sesiones legadas sin `created_by`?; (c) ¿el gate de publish va en el handler o dentro de `publishSpec`?
- **Decidido**: (a) **403** — los ids son UUIDv4, la enumeración es impracticable y el error honesto es el patrón del producto; (b) **solo-admin (fail-closed)** — una sesión sin dueño demostrable no se abre al scope, la rescata un admin; (c) **en el handler** — la identidad vive en la frontera HTTP y `publishSpec` conserva su contrato puro de gates de estado. Además se sella intocable el invariante de 004/02: la autorización de tools sigue atada al requester, no al dueño. Diseño completo: `work/005-…/01-diseno-pertenencia-sesiones-miranda-v1.0.md`.
- **Costo de revertir**: bajo — (a) cambiar el código de respuesta es una línea; (b) relajar el caso NULL es quitar una condición; (c) mover el gate al paquete es aditivo.

## D-07 · 2026-08-07 — `/contrato` solo para admins, y la pieza 2 de #138 no se implementa sin revisión

- **Bifurcación**: (a) ¿quién puede leer el contrato operativo de #139 — cualquier identidad autenticada tras el proxy, o solo admins?; (b) ¿se implementa de una vez la pieza 2 de #138 (env → archivo recargable) o se somete el diseño primero?
- **Decidido**: (a) solo admins (gate de token + `isAdmin` del store de gobierno; sin governance → 403): el payload expone rutas del contenedor y nombres de env — superficie de operación, no de consumo. (b) La pieza 2 queda en diseño (`work/003-…/03-…`) esperando a César: cambia el contrato de despliegue de las instancias (qué viaja en env vs en archivo) y arrastra semánticas de re-siembra vs gestión in-app.
- **Costo de revertir**: (a) bajo — relajar el gate es quitar una condición; (b) nulo — implementar después es el camino previsto.

## D-01 · 2026-08-06 — Orden y paralelización del backlog en 4 olas por territorio

- **Bifurcación**: atender 15 issues — ¿secuencial puro, o paralelo por territorio?
- **Decidido**: 4 olas (A: #99/#61/#117/#66 · B: #101/#114/#62/#108 · C: #105/#63/#109/#65 · D: #100/#102/#107), paralelizando frentes de territorio disjunto e integrando secuencialmente con gates. Dependencias: #101←#99, #63←#62, #102←{#99,#101,#100}.
- **Racional**: minimiza colisiones de archivos entre frentes y respeta las dependencias declaradas en los propios issues; los de demanda dura de usuario (#61, #99) van primero.
- **Costo de revertir**: nulo — es orden de trabajo, no forma del producto.

## D-02 · 2026-08-06 — #106 (docs) queda al final, condicional al tren

- **Bifurcación**: ¿incluir #106 (documentación multi-reporte + gobierno) en el alcance «todo lo accionable»?
- **Decidido**: se atiende solo si las olas A–D cierran; los issues de código tienen demanda de usuario y el doc no bloquea a nadie hoy.
- **Costo de revertir**: nulo.

## D-06 · 2026-08-06 — Encender vm-vergis-qa para el ensayo del deploy 0.14.0

- **Bifurcación**: la VM de QA estaba deallocated; ¿ensayar (encenderla) o saltar el ensayo?
- **Decidido**: encenderla — el ensayo en QA antes de PROD es el camino documentado (BITACORA 2026-07-13) y César autorizó «avanzar con el deploy», que lo incluye. Se deja apagada (deallocated) al terminar, como estaba.
- **Costo de revertir**: `az vm deallocate` (minutos de cómputo del ensayo).

## D-05 · 2026-08-06 — Se corta el release 0.14.0 en el repo (CHANGELOG + version + tag), sin deploy

- **Bifurcación**: dejar los 15 merges sin versión, o cortar 0.14.0 repo-side siguiendo la convención del CHANGELOG (Y sube con cada conjunto de capacidades).
- **Decidido**: version bump + entrada de CHANGELOG + tag `v0.14.0`. El DEPLOY a la VM queda como hand-off (producción gated; además #117 exige verificar los YAML de instancia antes de subir).
- **Costo de revertir**: bajo — el tag se puede re-cortar; nada desplegado.

## D-04 · 2026-08-06 — notify.yaml sin clave raíz LANZA (override del contrato sellado de #100)

- **Bifurcación**: el diseño de #100 selló `parseNotifyConfig({}) ⇒ cero destinos en silencio`; #117 (mergeado después de ese diseño) estableció que la clave raíz ausente en un YAML declarado es archivo roto y tumba el arranque. El implementador reportó la tensión sin resolverla.
- **Decidido**: consistencia con #117 — `requireRootKey('destinations')`; el cero legítimo es `destinations: []`. Racional: un notify.yaml decapitado desactivaría en silencio el sistema que avisa fallos — exactamente la evaporación que #117 cierra, en el peor lugar posible.
- **Costo de revertir**: una línea + un test (commit del ajuste en PR #129).

## D-03 · 2026-08-06 — Emails de avance: cuenta claude → cesar.obach@ultrabase.net

- **Bifurcación**: César pidió informes por email al cierre de tickets/olas; ¿a qué dirección?
- **Decidido**: desde la cuenta claude (claude.amodei@gmail.com) hacia `cesar.obach@ultrabase.net`, per skill `ww:wingworking-email-sending` (tema ultraBASE/producto; «si hay duda, ultrabase.net»).
- **Costo de revertir**: nulo — se redirige el siguiente envío.
