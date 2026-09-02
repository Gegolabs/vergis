# Changelog — Vergis

Versionado del Producto (la imagen `ghcr.io/gegolabs/vergis`). La versión vigente se muestra en el
pie del inspector de cada PI (`Mira v<versión>`, de `package.json`).

**Esquema X.Y.Z:**

- **Y** sube con cada conjunto de **capacidades nuevas** del DSL/runtime.
- **Z** sube con **correcciones sin capacidad nueva**. Existe para que un operador pueda tomar un
  arreglo **sin** tragarse funcionalidad que todavía no evaluó — el caso que lo justifica es la
  corrección de algo que induce a operar mal (ver 0.16.1). Precedente: 0.9.1.
- **X** se reserva para el primer release estable.

*La Z del Producto no es la Z de la Norma 3 de la Ley de Wingworking* (que rige **documentos** y
significa «solo cambió la forma»): acá un cambio cosmético del código no se publica solo, y lo que
merece número propio es la corrección que el operador querría adoptar aislada.

## Qué significa cada tag de la imagen

Publicar es un **acto deliberado**: el tag de versión lo mueve un tag de git, no un merge a `main`.

| Tag | Qué es | Para quién |
|--|--|--|
| `0.22.0` | Una versión publicada. **No se reescribe** | Producción — es el pin recomendado |
| `0.22` | Flota al último patch de la serie 0.22 | Producción que quiere correcciones sin capacidades nuevas |
| `latest` | La **última versión publicada** | Lectura y desarrollo local. No para producción |
| `main` | El último commit de `main`. Cambia sin aviso y puede traer trabajo a medio verificar | QA que quiere probar antes de la release |
| `sha-<commit>` | Un commit exacto | Diagnóstico y reproducibilidad |

No se publica el tag `0` (major solo): pre-1.0 el eje de ruptura es la **Y** de este mismo esquema,
así que `:0` prometería una compatibilidad que nadie sostuvo.

**El despliegue es del operador de la instancia, no del Producto.** Acá se publica la versión y se
declara qué trae y qué exige; qué versión corre cada instancia, cuándo entra y bajo qué control de
cambio lo decide quien opera esa instancia.

## Antes de cortar: el cotejo

`npm run corte:cotejo` contrasta las referencias `#NNN` de los commits del rango contra el texto de la
sección del CHANGELOG, en las dos direcciones: lo que el tag traería sin declarar, y lo que la sección
declararía sin que el tag lo traiga.

**Existe porque el corte comparaba lo que el humano recuerda.** La entrada de anillos I7+I8 quedó bajo
«Sin publicar» con su código dentro de `v0.21.0` (#242) y lo encontró una revisión de custodia por
casualidad. Retro-test contra el CHANGELOG **tal como estaba al taggear** —`git show
v0.21.0:CHANGELOG.md`, con `--changelog`—: lo habría atrapado.

**No es un veredicto.** Coteja por número: un cambio que nadie referenció en su mensaje de commit le
es invisible, y por eso su salida termina diciéndolo. Los commits sin ninguna referencia se listan
aparte, para mirarlos a mano.

**El corte exige además `npm run capacidades:cotejo` en verde**, y que cada `###` de capacidad nueva
bajo «Sin publicar» tenga su fila con `CAP-NN` en [`docs/capacidades.md`](docs/capacidades.md). El
catálogo es lo que un frente externo lee para saber si algo ya existe; una capacidad publicada sin
entrar ahí lo vuelve un índice que miente con la autoridad del repo. **No hay gate de CI que lo
exija** —un «este PR toca el CHANGELOG, ¿toca el catálogo?» es heurístico y frágil—: el cotejo verifica
la numeración y que lo declarado en máquina esté citado, y esta línea cubre el resto.

**Y el corte es también la cadencia del arnés de Fabric.** `npm run fab:proof` no puede vivir en un CI
—exige capacidad prendida, credenciales y plata—, así que su cadencia declarada es ésta: se corre
**antes de empujar el tag**, no después. El precedente que la fija es 0.21.0, cuyo centinela se midió
veinte minutos después del tag. Detalle y comandos en [`scripts/README-fabric-lab.md`](scripts/README-fabric-lab.md).

## Sin publicar

### Un `?page=` que el informe no declara ahora se lo dice al usuario, no solo al operador (#250)

**Cambia lo que ve la persona que llega por un enlace guardado.** Un `?page=<id>` que el spec no
declara se sirve —deliberadamente— con la primera vista y HTTP 200, para que renombrar una vista no
rompa los marcadores viejos. El operador ya se enteraba (evento `mira-page-unknown`, con `requested`
y `served`); la persona no: aterrizaba en otra vista sin que nada le dijera que su enlace apuntaba a
algo que ya no existe. Ahora la nav de vistas emite, bajo las pestañas, un aviso discreto —«La vista
«X» no existe en este informe; se muestra «Y»»— con `role="status"` para el lector de pantalla y
**visible en papel**, porque un PDF generado desde ese mismo enlace roto tiene el mismo problema. El
id pedido viene de la URL: se recorta a 60 caracteres y se escapa. **Nada cambia en el status HTTP ni
en el evento** — la salida elegida (D-59) declara el fallback, no lo suprime.

**Lo que NO se midió:** el aviso no se probó con un lector de pantalla real; lo verificado es el
marcado (`role="status"`) y su presencia en pantalla y en `@media print`.
### El catálogo de capacidades: `CAP-NN` estables para que una petición se conteste con una cita (#264)

Nace [`docs/capacidades.md`](docs/capacidades.md), un **índice de superficie** del Producto: qué
existe, cómo se llama, desde qué versión y dónde se explica, con identificadores `CAP-NN` **estables
que jamás se reusan** (una capacidad retirada conserva su número con estado `retirada`). No es un
manual de uso ni el roadmap: lo que no está construido no entra, salvo lo que el propio documento de
diseño declara como diseñado-y-no-construido, marcado como tal.

**Qué defecto cierra.** Desde afuera del repo no hay lista que leer, así que una petición que la
plataforma ya satisface se abre igual como issue. El caso que lo motivó: dos issues del mismo día
pidiendo capacidades que existían hace meses. Ahora se contestan con una URL y un ancla.

**Cómo se hizo, dicho con precisión.** El catálogo se **barrió a mano** sobre `CHANGELOG.md` entero,
`docs/`, el schema y el código. **Lo derivado mecánicamente son solo los tipos de pieza, los tokens de
formato, los tokens de `sort`, las claves de `interactions`, `controls[]` y `filters[]`, y las
clasificaciones — el resto puede tener omisiones.**

**Qué lo sostiene.** `npm run capacidades:cotejo` (y `tests/capacidades-catalogo.test.ts`, que corre en
la suite) verifica dos cosas y solo dos: la numeración —formato, duplicados, huecos no declarados
como retiro— y que **cada** elemento de esos conjuntos cerrados esté citado en alguna fila. Sus
derivaciones están **ancladas** a construcciones concretas del código: si una se mueve, el cotejo
falla nombrando el ancla perdida en vez de derivar una lista vacía y aprobar por omisión. Su control
negativo son fixtures que deben reprobar (ID duplicado, hueco sin retiro, tipo del schema ausente,
catálogo vacío).

**Hallazgo del barrido, de paso:** la tabla §9 de `docs/data-maestra-y-publicacion.md` declara el
mecanismo de publicación y el publish-on-write como «por construir», y el código los tiene
(`master-data-publish.ts`). El catálogo lo dice donde corresponde; corregir ese doc va aparte.

### `fast-uri` sube a 3.1.7: el advisory que tenía el CI en rojo

**Cambia una dependencia transitiva que viaja en la imagen.** `fast-uri@3.1.5` (vía `ajv`) recibió
cuatro advisories `high` (GHSA-5jgf-p345-68v8, -f65p-4m7j-42xc, -fph4-wmhf-6fwf, -jqff-g426-hqxp:
confusión de host y SSRF por normalización de URIs) posteriores al último verde de `main`, y
`npm audit --audit-level=high` dejó de pasar **antes** de typecheck y suite — con cuatro PRs
abiertos sin señal de CI. El bump es quirúrgico (solo la entrada de `fast-uri` en el lock) y queda
fijado con `overrides` en `package.json`, para que ninguna resolución futura lo baje sin decirlo.
No se tocó ninguna otra dependencia: `npm audit fix` además dedupaba entradas de esbuild, y un
parche de seguridad no lleva pasajeros.
### El rótulo del punto apuntado se realza, y el gráfico gana su segundo gesto estándar (#263)

**Cambia lo que ve quien mira un gráfico en pantalla; en papel no cambia nada.** En una línea con
muchos puntos el rótulo del valor solo se dibuja cada N puntos (anti-colisión de #94), así que la
mayoría de los puntos no dice su valor por ningún medio salvo el tooltip nativo de #208, que hay que
ir a buscar uno por uno. Ahora **todos** los rótulos existen en el SVG —los que el stride no muestra
viajan con `opacity="0"`— y el que está bajo el cursor se revela y se agranda, junto con el de su
punto. Aplica igual a líneas y a barras: es **una decisión de plataforma, no configurable por spec**.

**Cómo funciona, y por qué hay JS:** el `<path>` de la marca y el `<text>` de su rótulo comparten la
llave `aria-label` (el canal `description` de vega-lite la escribe en ambos), pero viven en `<g>`
distintos — capas separadas del layer. **Medido sobre el SVG que emite Vega**: ningún selector CSS
cruza de un grupo al hijo de otro, `:has()` incluido. El emparejamiento lo hace un listener delegado
de ~15 líneas sobre el SVG ya horneado: no hay motor de gráficos en el cliente, no hay runtime de
Vega, no viaja dato y no hay estado que sincronizar. En `print` no viaja nada (#65 · D4), y un
documento sin gráficos no paga ni una línea de CSS.

**Lo que NO se midió, dicho como tal:** no se probó con lector de pantalla que los `<text>` con
`opacity="0"` no se anuncien de más. Si molestara, marcarlos `aria-hidden` es el siguiente paso.
También queda declarado que en táctil no hay realce — no hay hover que capturar, igual que el
tooltip nativo.

### El diagnóstico del smoke deja de leer la fase de un cuerpo que no fue 200 (`phase_reportada()`)

**Cambia `vergis-rollout`, que viaja al operador.** El `warn` del smoke leía la fase con `phase_of()`
sin gate de status: ante un cuerpo de error que contenga el literal `"phase":"serving"` —la familia
que `espera.html` tuvo hasta 0.22.0— el diagnóstico imprimía `fase='serving'` justo cuando alguien
está averiguando qué pasó. El lector nuevo, `phase_reportada()`, exige el `200` antes de leer la fase
y **dice** cuando no lo hubo (`sin-fase(http-503)`). **No sustituye a `phase_of()` donde un no-200 es
legítimo**: `starting` se sirve con 503, y gatear ahí cegaría al que espera un arranque — son dos
lectores porque son dos preguntas. El control negativo vive en la suite (cuerpo envenenado: el lector
sin gate sigue diciendo `serving`, el gateado no), no en una corrida que haya que acordarse de repetir.

*(El resto de esta rama —extensiones del banco `deploy/rollout/bench/` y el registro del arnés
V2–V13— no viaja al operador y no lleva entrada.)*

### Las facetas de un dashboard reciben el tope + buscador de #209, y su hoja deja de viajar solo cuando hay filtros server-side (#255)

**Cambia lo que ve quien usa un PI con facetas de catálogo grande.** El patrón de #209 —tope de
opciones visibles, «Ver las N restantes» y buscador— existía solo en los filtros server-side
(`renderTrayFilters`), pese a que las facetas client-side comparten el mismo `.faceta-options` de
220 px con scroll interno: dentro de un catálogo de 47 valores la opción buscada se encontraba
scrolleando a ciegas, que es exactamente el síntoma que motivó #209.

**Y con él viajaba un defecto que nadie había reportado**: el CSS del patrón y el script del buscador
se inyectaban bajo `if (trayFilters)`, así que un dashboard con **solo** facetas emitía las marcas
(`vflt-extra`, `vflt-search`) sin la hoja que las pliega ni la función que las busca — el «ver más»
quedaba inerte y el tope, invisible. El gate ahora también reconoce las facetas.

**La opción marcada no se pliega, y eso lo resuelve el runtime, no el render.** En los filtros
server-side la selección viaja en la URL y el HTML nace sabiéndola; en las facetas el estado vive en
el DOM y cambia sin re-render, así que `update()` —el único punto por el que pasan el change del
checkbox, el ✕ del chip, «limpiar» y la restauración de una vista guardada— aplica y retira
`vflt-keep`. La precedencia de la hoja es deliberada: `keep` gana a `extra`, `miss` gana a `keep`, de
modo que una búsqueda sin coincidencia oculta también lo marcado, igual que en server-side.

El plegado sigue siendo **CSS-only** aunque acá el filtrado ya dependa de JS: es una sola
implementación del patrón para las dos superficies (cero deriva) y degrada igual en papel, donde el
script no viaja.

**Lo que se midió**: los ocho tests de `tests/facetas-tope-buscador.test.ts`, cada uno con su corrida
de contraste contra el código anterior. **Lo que NO se midió**: el comportamiento en un navegador
real —el `new Function` del test valida sintaxis, no conducta—, así que la interacción efectiva de
`vflt-keep` bajo el cursor de una persona sigue sin verificarse con los ojos.
### La doctrina de gobierno recomienda `GRANT UNMASK` por columna; el rol del workspace queda como alternativa con su costo declarado (#245)

**Cambia documentación que el operador lee para decidir qué privilegio concede.** `docs/gobierno-permisos.md`
presentaba el **rol del workspace** como lo que «decide» `UNMASK`, y eso empuja a conceder privilegio
sobre **todo** el workspace —lectura y escritura de todos sus items— para habilitar la lectura de **una
columna**, con una revocación que **no propagó en más de 20 minutos** y cuyo techo nadie midió. La
sección pasa a nombrar las **dos vías** con su alcance y su reversión, y a poner primero la sentencia
copiable `GRANT UNMASK ON [dbo].[<tabla>]([<columna>]) TO [public]` con su `REVOKE`. La vía del rol se
conserva —hay instancias que ya la usan— diciendo qué concede de más y cuánto tarda en quitarse.
`scripts/README-fabric-lab.md` y el comentario de `scripts/fabric-lab-proof.ts` dejan de decir que el
rol «decide» y dicen lo que es cierto: decide el **privilegio del principal**, y el rol es una de las
dos formas de dárselo.

**Qué se midió y qué no.** Lo medido está en 0.22.0 · E3 y en #245: contra el SKU F2 del terreno propio,
con el principal verificado en el plano de datos antes de tocar nada, el motor **acepta** la sentencia,
**surte efecto** en conexión nueva, la vista **sigue discriminando** por el claim, y el `REVOKE` se
verificó leyendo el dato. **No** se midió en el warehouse de una instancia de cliente, ni con más de un
principal presente en la base —el alcance real de `public` ahí es semántica, no medición—, ni si el
`GRANT` sobrevive a un `ALTER` de la tabla o a re-aplicar la política. Los tres límites viajan escritos
en la doc. Sin cambio de comportamiento del Producto: no se emite `GRANT` alguno, y si el emisor de DDL
debería emitirlo queda escrito en la doc como **decisión abierta**.

## 0.22.0 — 2026-08-26

### Qué exige esta versión

> **Nada nuevo del motor ni de la base**, y conviene decirlo primero: quien ya satisfizo lo que exigía
> 0.21.0 no tiene que conceder nada más. Lo que 0.22.0 exige es del **procedimiento de despliegue**.

- **La herramienta de anillos es la de este repo, no la que ya esté en la VM.** `promote` cambió su
  orden de operaciones y el `rollback` delega en él: correr la herramienta vieja contra un Producto
  nuevo no rompe nada, pero **no obtiene el orden nuevo** — o sea que se paga el tramo (a) igual y la
  medición de V-14 no aplica. Copiar `deploy/rollout/vergis-rollout` es parte de adoptar esta versión.
- **El presupuesto por default de la ventana bajó de 30 s a 10 s** (`RINGS_PROMOTE_TIMEOUT` /
  `--timeout`). Es deliberado —el tráfico se compromete antes de que el candidato tenga el control— y
  es la cota superior de la ventana del intent de handover. Quien tenga el valor fijado por env sigue
  con el suyo: revísenlo.
- **`Caddyfile.reference` baja `health_interval` a 250 ms.** Es **plantilla, no obligación**: recorta la
  cola de latencia, no la correctitud, y su costo está declarado al lado. Un despliegue que no lo adopte
  sigue siendo correcto — más lento en soltar a los retenidos, nada más.
- **Sigue vigente lo de 0.21.0** para quien venga de antes: el principal de serving debe poder leer el
  valor real de las columnas gobernadas, y hay que regenerar y re-aplicar la DDL de la política. **Y su
  recomendación cambió** — ver la corrección de E3 más abajo: `GRANT UNMASK` por columna es mejor vía
  que subir el rol del workspace, y es la que esta versión recomienda.

### Lo que sigue sin medirse, dicho con esas palabras

- **Producción.** Todo lo del conmutador se midió en **banco local** (Docker, 9 PIs, motor
  `clickhouse`), con su control reproduciendo el defecto viejo tres veces. Un despliegue real
  **corrobora**; no es la medición que falta.
- **La dispersión del tramo (a)** —234–762 ms, 9–27 respuestas en el orden viejo— **no está explicada**.
  Se afirma que el tramo existe y quién lo abre y lo cierra; su tamaño no.
- **Qué le hace el `caddy reload` del flip-back a los requests retenidos.**
- **El cierre de #232 es parcial y por diseño**: el intent ordena la fila solo entre quienes pasan por
  `intentarRelevo`. La marca de release **sigue siendo subasta abierta** por cualquier otro camino. Lo
  que esta versión garantiza es que **la promoción orquestada es determinista** — no que soltar el
  control sea una entrega.
- **La ventana del arnés de Fabric se corrió ANTES de este tag** (2026-08-26, 13:12–13:14 UTC): 26
  hallazgos, 0 fallos, 0 sin medir, capacidad devuelta a `Paused`. Es la cadencia declarada, y existe
  porque en 0.21.0 esa misma medición se hizo **veinte minutos después** de empujar el tag.

### La promoción de anillos conmuta el borde ANTES del handover, y el relevo va DIRIGIDO por un intent (#232, parcial)

**Cambia el orden de operaciones de `vergis-rollout promote`** (y del `rollback`, que delega en él):
antes era pre-flight → handover del control → flip del borde; ahora es pre-flight → **intent de
handover** → **flip del borde** → handover → smoke. Desde el flip, ningún request nuevo llega al nodo
que está por soltar el control: los que entran mientras el candidato todavía no sirve quedan
**retenidos** por la sala de espera del borde en vez de responderse por un nodo en espera.

**Qué afirma esta entrada, y con qué alcance — medido, no prometido (V-14, 2026-08-26, arnés local
`deploy/rollout/bench/`, 9 PIs sobre motor clickhouse):** bajo el orden nuevo, **cero respuestas fuera
del predicado** (`200 ∧ phase=serving`) en 3 promociones, 3 rollbacks —medidos aparte, y la corrida
destapó y corrigió que `rollback` descartaba sus flags— y una carrera de **20 promociones seguidas**
(5.604 muestras crudas, 0 `200∧standby`, 0 5xx, 0 sin-medir, 0 warns de carrera del lease). El mismo
instrumento, contra el **orden viejo**, anotó el defecto tres veces (9, 18 y 27 respuestas
`200∧standby`, ventanas de 234–762 ms que abre el release y cierra el health check) — control
negativo del mecanismo, sin el cual esta cifra no valdría. La latencia del acto es **retención, no
error**: p50 4–6 ms, p100 0,5–2,5 s, todos los retenidos terminados en `200∧serving`.
**Qué NO afirma:** nada sobre producción — la medición es del arnés local; el comportamiento del
flip-back sobre requests retenidos (tramo (b)) sigue **sin medir** y su banco (V-15) está pendiente.

**El handover dirigido.** La herramienta escribe `${VERGIS_OUT}/control.handover.json` =
`{successor, expiresAt}` —hermano del archivo de lease, mismo volumen y mismo modelo de confianza—
antes de pedirle al activo que suelte. El nodo nombrado adquiere **de inmediato**, saltándose la
ventana de gracia que se impone a sí mismo quien acaba de soltar; los demás **se abstienen** mientras
el intent esté vigente. El nodo lo consume por un **watch** (la misma infraestructura que el resto de
los watches del proceso, visible en `/contrato`) y, si el evento se pierde, por su poll de relevo, que
ahora también lo lee: un watch perdido enlentece el protocolo, no lo rompe. Un intent **vencido**, o
ilegible, es inexistente — el `expiresAt` es lo que impide que un intent huérfano (la herramienta
murió, o el sucesor nombrado nunca llegó) congele los relevos.

**Lo que queda garantizado y lo que no — cierre PARCIAL de #232, por diseño.** El intent **ordena la
fila; jamás otorga el control**: `acquire()` y el fencing de época no se tocan, y el modo de falla
sigue siendo hacia cero controladores, nunca hacia dos. Consecuencia, dicha con todas sus letras:
`releaseSync()` deja `{holder:'', epoch}` y `#attempt()` concede ese archivo al **primero que llegue
sin mirar quién**, así que el intent ordena la fila **solo entre quienes pasan por `intentarRelevo`**;
la marca de release sigue siendo **subasta abierta** para cualquier camino que no pase por ahí.
Cerrarlo del todo exigiría meter el intent dentro de `acquire()` —convertirlo en autoridad—, que es
justamente lo que este cambio no hace. Hay un test que lo mide como límite, no como bug.

**Costo declarado del orden nuevo.** El tráfico se compromete **antes** de que el candidato tenga el
control: un relevo que no llega deja gente esperando en la sala de espera —latencia, no errores—
hasta la vuelta atrás. Por eso el presupuesto por default de la ventana baja de 30 s a **10 s**
(`RINGS_PROMOTE_TIMEOUT` / `--timeout`), y por eso la vuelta atrás **empieza devolviendo el tráfico**
al anillo anterior, después reescribe el intent nombrándolo a él —para que re-adquiera sin pagar su
ventana de gracia— y solo entonces le pide al candidato que suelte. Qué le hace a los requests
retenidos el `caddy reload` de ese flip-back **no está medido**: se declara, no se supone.

**Para el operador de la instancia.** `Caddyfile.reference` baja `health_interval` de `1s` a `250ms`,
con su costo declarado al lado (4 req/s por upstream contra `/healthz`, un JSON de conteos sin gate):
es recorte de la **cola de latencia** —cuánto tarda la sala de espera en soltar a los retenidos una vez
que el anillo nuevo satisface el predicado—, **no** correctitud; lo que evita rutear a un nodo en
espera sigue siendo el predicado `200 ∧ phase=serving ∧ pis.serving=pis.total`, que no se toca. El
Caddyfile es una plantilla: adoptar el valor es decisión de quien opera. Un despliegue que no use
anillos no cambia en nada.

### La sala de espera del borde ya no envenena a un lector de fase por expresión regular (#256)

`deploy/edge/espera.html` —el cuerpo del **503** que Caddy sirve cuando ningún anillo declara la fase
`serving`— llevaba ese literal escrito en un comentario. Cualquier lector que extraiga la fase del
cuerpo por regexp leía `serving` **de la página que significa justo lo contrario**.

**El veredicto de ruteo NO estaba comprometido** y va dicho para no inflar el hallazgo: `serving_ok`
de `deploy/rollout/vergis-rollout` exige `200` **antes** de mirar la fase, y esta página se sirve con
503. Lo que sí mentía era el **diagnóstico**: el `warn` del smoke llama al extractor sin ese gate, así
que ante un 503 imprimía `fase='serving'` — exactamente cuando alguien está averiguando qué pasó.

Medido con sus dos controles: el extractor real (`sed`) sobre la página anterior devuelve `serving`,
sobre la corregida devuelve vacío, y sobre un `/healthz` de verdad sigue devolviendo `serving` — o sea
que se cortó la trampa sin romper el instrumento. **Se corta en la fuente y no en cada lector**: los
lectores se multiplican, este archivo es uno.

Hallado por el frente `arbol` midiendo el banco del conmutador de anillos.

### Lo que se endureció puertas adentro, y el operador no ve (#256)

Nada de esto cambia el comportamiento del Producto: se declara porque **cambia cuánto vale su verde**.

- El `typecheck` del repo **no miraba `scripts/`** — daba verde por ausencia. Al abrirlo aparecieron
  cuatro errores de tipo y **dos arneses rotos**: uno moría al correr, el otro reportaba la falta de su
  insumo con un stack crudo en vez de decir «no pude medir».
- **El pin de shellcheck** vivía en dos archivos atado solo con comentarios cruzados. Ahora lo ata un
  test.
- **El corte de versión no cotejaba nada** contra lo que el tag contiene — esta misma sección se
  verificó con `npm run corte:cotejo` antes de cerrarse, y el procedimiento está arriba.
- El eslabón **renombrar → catálogo servido** (#207) pasó de estar cubierto por lectura a estar medido.
- Los dos arneses que no corrían en ningún gate ya tienen **uno cada uno**: el de T-SQL, un workflow
  con filtro de `paths`; el de Fabric, una **cadencia** — el corte de versión, antes del tag.

Los cinco tenían la misma forma: **un control que no controlaba**, y ninguno se caía. Se dicen acá
porque quien lee un CHANGELOG está decidiendo cuánto confiar en la versión, y eso depende tanto de lo
que trae como de lo que la midió.

### Dependencias

- `tedious` ^19.2.1 → **^19.2.2** (#252) — patch dentro del mismo minor; el salto a v20 sigue
  esperando su propio cooldown de 14 días (ADR-001). Sin cambio de comportamiento observable.

### Las acciones por proceso de Frescura validan la PERTENENCIA del proceso al dominio (#253)

Las tres acciones por proceso de **Frescura** —pausar, reanudar y aplicar cadencia— se autorizaban
**solo por el dominio de la URL** (`canMng`). El proceso sobre el que actúan, en cambio, llega en el
**formulario**, y su pertenencia a ese dominio no se comprobaba en ninguna capa: la autorización cubría
*la página*, no *el objeto sobre el que la página actúa*. Un steward del dominio A podía pausar un
proceso del dominio B fabricando el `process` del form.

**El arreglo replica el mecanismo que ya rige en las rutas hermanas del mismo módulo** —`runLogs.refOf`
y la consola de Cargas—, no inventa un eje de autorización nuevo: la pertenencia **se hereda de la
fuente que ingesta**, que es el mismo criterio con que la vista de Frescura arma su lista. El predicado
es puro y **fail-closed**: proceso desconocido, fuente desconocida o fuente sin dominio ⇒ se niega.

Verificado con control negativo por los dos frentes: neutralizado el predicado —la conducta previa al
arreglo— **5 tests quedan en rojo**, y otros 4 si la ruta deja de entregarle el dominio a las acciones.

**Un steward que opera su propio dominio no nota diferencia**: no cambia el contrato hacia el usuario,
ni la configuración, ni las dependencias.

### Los tres experimentos que 0.21.0 declaró «sin medir» quedaron medidos — y uno cambia la recomendación (#238 · E3/E4/E5)

**0.21.0 exige que el principal de serving pueda leer el valor real de las columnas gobernadas, y dijo
—con esas palabras— que tres experimentos quedaban sin medir.** Dos ya no lo están, y el resultado del
primero **cambia lo que hay que recomendarle a quien opera**.

**E3 · hay `UNMASK` granular por COLUMNA, así que no hace falta subir el rol del workspace.** Medido
contra el SKU: `GRANT UNMASK ON [esquema].[tabla]([columna]) TO [public]` se acepta, **surte efecto**
(que no es lo mismo: es la lección de #197), **la vista discrimina** correctamente con el claim, y el
`REVOKE` se verificó **en el plano de datos**. Frente a la vía del rol `Member`, esta es del tamaño del
dato que protege y **su revocación sí es inmediata** — la del rol no propaga en más de 20 minutos, con
techo desconocido.

Con dos límites que van dichos: `public` es un rol al que pertenece **todo** principal de la base, así
que la capacidad alcanza a cualquiera que pueda consultar ese warehouse, y **no se puede hacer más
fino** porque Fabric no permite crearle un usuario propio a un service principal (`CREATE USER … FROM
EXTERNAL PROVIDER` no está soportado — medido, no supuesto). Si en ese warehouse consultan otros
principals, esto los alcanza.

**Qué hacer con esto es decisión de quien opera**, y por eso Vergis no la toma: el Producto **mide** si
la lectura desenmascara y le da igual cómo se logró. Lo que cambia es la recomendación — de «súbele el
rol» a «concédele esta columna». Ver issue #245, que también recoge la pregunta abierta de si el
emisor debería emitir ese `GRANT` él mismo.

**E5 · el centinela distingue sus tres estados también en Fabric.** Verde, y ahora **dentro del arnés**
(sondeo P10) en vez de en un experimento suelto: las 3 sentencias aceptadas, idempotencia real, el
descubrimiento encontrándolo, `sys` corroborando la máscara, el control positivo del instrumento (un
sujeto con la capacidad lee el valor esperado) y el retiro **verificado leyendo**, no supuesto porque
la sentencia no diera error.

**E4 sigue sin medir**, y ahora se sabe qué costaría: exige cambiar la capacidad y sondear una conexión
viva por mucho más tiempo. Por la vía del rol arrastra la staleness de revocación (>20 min, techo
desconocido) y deja el terreno inutilizable; por la vía del `GRANT` es viable y queda para una ventana
propia. Lo que sí está medido, y es lo que importa para operar: **una conexión ya abierta no se enteró
nunca** de un cambio de rol dentro de la ventana de sondeo, o sea que **la autorización se fija al
conectar**.

### El healthcheck del despliegue de referencia juzga por la FASE, no por «responde»

El `healthcheck` de `docker-compose.yml` juzgaba por el código HTTP, y desde 0.20.0 eso **da «sano» a un
nodo que no sirve**: un nodo en `standby` responde `200` con `ok:true` **por diseño**. Ahora exige el
predicado canónico —`200 ∧ phase=serving ∧ (sin bloque pis ∨ pis.serving == pis.total)`—, el mismo que
usan el conmutador del borde y la herramienta de anillos.

**Y `deploy/compose.reference.yml` lo trae por primera vez** en su servicio `vergis`: ese archivo
documenta el modo de **un solo nodo**, y ahí el servicio *es* el que sirve. Va con su advertencia
escrita al lado, porque la mala lectura es fácil: **es diagnóstico, no ruteo** —quien rutea es el
conmutador del borde— y los anillos **no lo heredan**, porque su salud la mide el borde, que es el
único que puede actuar sobre ella.

Si copiaste la plantilla, este bloque es lo que hay que traer. **Hoy no cambia nada en una instalación
corriendo**: sin un `depends_on` con `condition: service_healthy`, nada enruta por esta señal. Muerde el
día que algo lo haga.

### Las claves de un control son un conjunto cerrado (#248)

`controls[]` aceptaba **cualquier** clave: una inventada —o el **typo** de una real— pasaba en silencio,
el control caía a su default de siempre y nadie se enteraba de por qué el PI abría en la opción
equivocada. Ahora una clave no declarada **es error de spec**, ruidoso, al validar.

Es la contracara del check que trae `defaultField`: allá se atrapa el typo en el **valor** de la clave,
acá el typo en su **nombre**. Las ocho declaradas son `id`, `label`, `source`, `param`, `display`,
`default`, `defaultField` y `single`.

**El riesgo se midió antes de cerrar**, y desde la instancia: 9 specs, 7 claves distintas en uso, todas
dentro de las 8 — cero specs afectadas y ningún typo vivo. Medido con **parseo YAML y no grep** (un grep
confunde niveles: una clave dentro de un `options:` no es clave *del* control) y **contra lo desplegado,
no solo contra el repo**.

**Lo que esto implica para quien opera, y es lo único que cambia en su rutina:** al estrenar una
capacidad de control nueva, **el orden importa — el Producto primero, la spec después**. Antes una spec
podía adelantarse usando una clave que su versión del Producto no conocía y el control simplemente la
ignoraba; ahora ese spec **no arranca** hasta que corra la versión que la declara. Es el efecto buscado
—una clave que nadie lee es un defecto silencioso— con su costo dicho.

### El default de un control puede venir DEL DATO, y el default literal vuelve a ser alcanzable (#235 + #246)

**Dos cosas, y la segunda es la que explica por qué la primera no podía existir sola.**

**El default puede ser MÓVIL (`controls[].defaultField`, #235).** Hay defaults que se definen por su
relación con *hoy* y no por su posición en el dominio: «la semana siguiente», «la campaña vigente», «el
período contable abierto». Ninguno se podía expresar. El literal de #92 **caduca** —`2026-08-24` es «la
semana siguiente» durante siete días y al octavo apunta al pasado— y `first` no da acceso al orden del
SQL, porque las opciones se ordenan por su `value`. El sustituto que quedaba era acotar el dominio para
que la opción buscada fuera el `max`: arregla el default y **rompe el requisito**, porque el usuario
deja de poder mirar más allá.

Ahora el **dato** designa la opción, marcando una columna del mismo dataset que produce las opciones —
el mismo SQL que conoce el calendario:

```yaml
controls:
  - { id: semana, source: data.semanas.semana, display: etiqueta, defaultField: es_default }
```

- **Qué cuenta como verdadero es una lista CERRADA**, no truthiness de JavaScript: `true`, `1`, `'1'`,
  `'true'`, `'t'`, `'s'`, `'si'`, `'sí'`, `'y'`, `'yes'` (minúsculas, con `trim`). Todo lo demás
  —incluidos `false`, `0`, `'0'`, `'false'`, `'N'`, `null` y la cadena vacía— es **falso**. La columna
  llega con el valor **crudo del driver** (un `BIT` de mssql da `true`/`false`, un `CAST AS INT` da
  `1`/`0`, un `CASE WHEN` da `'S'`/`'N'`, las filas no marcadas suelen dar `null`), y `String(false)` es
  `'false'`, que en JS es *truthy*: con truthiness cruda, **todas** las filas quedarían marcadas.
- **Exactamente UNA opción marcada** designa el default, y gana sobre `default`. Ninguna o más de una y
  `defaultField` no resuelve: se evalúa `default`, y de ahí al comportamiento sin default, que es
  **`max`**. Es **fail-safe**, no fail-closed — el conteo depende del dato, así que un SQL que un día
  marca dos filas no puede dejar el PI caído. Y el conteo es sobre **opciones** (después del dedup por
  `value` y del descarte del `value` vacío), no sobre filas: dos filas del mismo `value` son una sola
  opción, y una fila marcada con `value` vacío no es opción ninguna.
- **Cuando no resuelve, se ve**: evento `mira-control-default-field` con el control, el dataset, el
  campo, cuántas quedaron marcadas y el fallback aplicado, distinguiendo «ninguna» de «más de una». Es
  lo que separa un fail-safe de un silencio: un PI que abre en la semana equivocada porque el SQL dejó
  de marcar la fila se diagnostica leyendo el log, no adivinando.
- **La URL sigue ganando** y **solo el dueño del `param`** aplica el default — las dos reglas se heredan
  sin escribirlas, porque el valor que designa el dato entra por la misma puerta que el literal de #92.
- **El campo colgante es error de SPEC**, ruidoso y estático (`control-default-field-dangling`). Sin ese
  check un typo en el nombre habría sido **mudo**: `controls.items` tolera claves desconocidas, el
  control caería a `max` y nadie sabría por qué el PI abre donde abre.

**Y el default LITERAL de #92 vuelve a ser alcanzable (#246).** La entrada que #92 nunca tuvo, y la
razón por la que este cambio necesitaba dos issues: el schema cerraba `controls[].default` en
`enum: ["max","min","first"]`, y el schema corre **antes** de la validación semántica —que sí aceptaba
el literal—. O sea que **la capacidad se publicó inalcanzable desde un spec**: cualquier `default` que
no fuera uno de los tres keywords se rechazaba al validar. El vocabulario del schema pasa a ser «string
no vacío», que es exactamente lo que la validación semántica ya exigía: dos fuentes del mismo contrato
que ahora dicen lo mismo. El mismo `enum` habría bloqueado cualquier default nuevo, así que arreglarlo
no era un vecino de #235 sino su primer paso.

El defecto sobrevivió cinco meses porque el test que lo tocaba lo **bendijo**: afirmaba «default
inválido → rechazo» con un valor literal y comentaba que «lo atrapa el schema (enum)» como si eso fuera
correcto. Ese test ahora **distingue qué capa rechaza**, y la suite trae el `validateSpec` completo —con
schema— sobre un spec con `default` literal, que es la medición que faltaba.

**Compatibilidad.** Ambos cambios son aditivos: un spec sin `defaultField` se comporta idéntico, y el
schema solo se abre —jamás rechaza algo que antes aceptaba—.

### El contrato público del cambio: la imagen declara su esquema, las migraciones tienen regla y la promoción tiene ceremonia (#210 · I9+I10)

**Esto completa el cambio del CONTRATO DE DESPLIEGUE** que traen **0.21.0** (el conmutador y la
herramienta de anillos, I7+I8) y **0.20.0** (los dos planos cableados, I4+I5+I6). Ahí quedó
el mecanismo; acá queda **lo que hay que poder leer para operarlo**, que es la mitad que decide si un
rollback de emergencia se puede ejecutar a las tres de la mañana o hay que averiguarlo en el momento.

**Qué gana quien opera.**

- **La imagen declara qué esquema de store soporta.** Dos labels nuevos: **`vergis.schema`** (el store
  de gobierno, un entero) y **`vergis.schema.stores`** (el mapa completo, `gobierno=1,notas=1,
  data-maestra=1` — en plural porque un solo número esconde al store que sí bloquea un rollback). Con
  eso, una incompatibilidad de esquema se descarta **leyendo metadata de la imagen**, sin arrancar el
  candidato:
  `docker inspect --format '{{index .Config.Labels "vergis.schema.stores"}}' ghcr.io/gegolabs/vergis:<versión>`.
  Es una negativa **temprana**, no la única: el gate autoritativo sigue siendo el pre-flight de la
  promoción contra el bloque `control` de `/contrato`. Los labels `org.opencontainers.image.*` siguen
  saliendo de la metadata de git en el build — no se duplican.
- **Los labels no pueden mentir por descuido.** La suite compara el literal del `Dockerfile` contra las
  constantes `*_SCHEMA_VERSION` del código **y** contra la lista de stores que el server cablea de
  verdad: subir una constante sin el label, o agregar un store embebido sin declararlo, deja el CI
  rojo. El guard se falsificó (con un label que miente, la suite se pone roja nombrando ambos números).
- **La regla de migraciones queda escrita y es ejercible.** Dentro de la ventana de retención —las
  últimas `RINGS_RETAIN` versiones publicadas, default 3— las migraciones del store son **aditivas y
  compatibles hacia atrás**. Una migración incompatible exige **subir `SCHEMA_VERSION` en el mismo
  commit** y anunciarlo en este archivo con la frase que un operador puede buscar: **«rompe rollback a
  < X.Y»**. Con tabla de qué cuenta como aditivo y qué no, qué hace el autor del PR y **qué hace valer
  la regla por él** (el rechazo al abrir el archivo, el pre-flight y el label). Está en la doc de
  contribución.
- **La promoción tiene runbook** (`deploy/rollout/RUNBOOK.md`): la secuencia exacta con verificación
  por paso y su vuelta atrás, el recon read-only previo, qué se registra después, y las tres maneras de
  volver atrás (al previo caliente, a un retenido, y qué hacer si quedan **cero** controladores). El
  README de `rollout/` sigue siendo la referencia de la herramienta; el runbook es la ceremonia.
- **Y trae la ley del instrumento, que es lo que lo distingue de un README.** El corte **se mide**: el
  comando miente (rc=0 en 375 ms mientras las rutas no sirven — un factor de 9 a 20). El predicado es
  `200 ∧ phase=serving ∧ pis.serving == pis.total`, jamás «responde». El poller vive en un contenedor
  que el acto **no** recrea —uno efímero muere durante el acto y solo acota el corte por abajo—, va
  escrito y listo para copiar, y **cuenta como fallo el no haber podido medir**. El **control negativo
  es obligatorio**: una medición cuyo instrumento no demostró saber ver el fallo no vale.
- **El modo de falla que hace falso a un control negativo verde, citado con su medición.** Bajar
  `lb_try_duration` a `1ms` en el `Caddyfile` **del host** dejó el control en verde y la conclusión
  habría sido falsa: el compose monta ese archivo como **archivo**, un `sed -i` cambia su inodo y el
  contenedor siguió viendo lo viejo. La regla que se deriva y queda escrita: **la configuración se
  verifica leyéndola del sujeto vivo** (su API de administración), no del archivo que editaste; y para
  degradarla, `docker cp`, editar dentro, o montar el **directorio**.
- **El límite de un solo host queda donde el operador lo lee** (I10): en el compose de referencia,
  junto al montaje de `VERGIS_OUT`, y en el runbook. El plano de control se ordena por rename atómico y
  relojes del mismo kernel, así que un **volumen de red** (NFS, SMB/CIFS, EFS, Azure Files) o anillos
  repartidos en dos hosts quedan **fuera de contrato**: no soportado, no medido. Si `VERGIS_OUT` vive en
  un share de red, el mecanismo **no aplica a esa instalación** y el compose lo dice ahí mismo.

**Lo que este trabajo NO promete: corte cero.** El runbook lo declara de frente: la promoción medida
**no fue corte cero** — en el e2e del frente anterior hubo un tramo de **≈1,9 s** sin satisfacer
`phase=serving`, con **0 PIs** y **cero respuestas de error crudas**. Lo que el mecanismo elimina es el
**error** y el **recreate con su ventana**; lo que deja es un tramo corto de escritura congelada con 409
explícitos. La cifra viene de un host de desarrollo y **no caracteriza** una instalación con carga: el
runbook manda medir el corte propio y registrar la fila **incluso cuando no se pudo medir**, diciendo
por qué — una fila ausente hace creer que el corte no ocurrió.

### Un nodo que nunca llegó a servir no retiene el plano de control (#228)

Un arranque que moría **después** de tomar el lease —configuración incompleta, credenciales inválidas,
cualquier `throw` del arranque— dejaba el archivo de lease con un titular que ya no existe y **sin marca
de release**: el release ordenado cuelga de `SIGTERM`/`SIGUSR2`, y una excepción no pasa por ahí. El
costo lo midió el frente arbol con su arnés de dos nodos: **≈11,5 s en el caso peor** hasta
`phase=serving`, contados desde la última renovación del huérfano — y durante esa ventana el nodo, el
**único vivo**, se declara `standby` citando un `pid` muerto, así que un conmutador con el predicado
`phase=serving` no le manda tráfico. No era un retraso de arranque: era indisponibilidad con un nodo
sano.

**El arreglo suelta el control en el camino de excepción**, no reordena la adquisición: la adquisición
tiene que ocurrir antes de abrir un solo store (el modo de apertura y el gate de época dependen de ella)
y hay validaciones que lanzan **después** de que el primer store abrió, así que ningún reordenamiento
cubre el arranque entero — y cualquier validación futura agregada más abajo lo reabriría en silencio. El
handler de salida del proceso cubre el camino de excepción completo con independencia de dónde esté el
`throw`; es idempotente y **no pisa a un sucesor** (relee y solo escribe si el titular sigue siendo este
nodo). Un `SIGKILL` sigue fuera de alcance: para eso está el stale window.

Verificado arrancando el server de verdad con la configuración incompleta del issue: antes deja
`holder: "vergis@<host>/<pid>"`, ahora deja la marca de release con la época conservada, y el sucesor
adquiere de inmediato.

## 0.21.0 — 2026-08-19

**⚠ Esta versión EXIGE algo nuevo de la instancia.** Un requisito de configuración que antes era
implícito pasa a ser **cláusula del contrato**, verificada por el Producto: si no se cumple, los PIs
con reglas de columna **no se sirven** y el motivo lo nombra. Léase la sección «Qué exige» antes de
adoptarla.

### La protección de columna no discriminaba para el sujeto que sirve (#238)

**El defecto, medido:** la vista de máscara `vw_mask_<tabla>` devolvía **lo mismo con y sin el claim**
cuando la consulta el principal de serving sin capacidad de desenmascarar. La vista lee la tabla, y
el DDM enmascara **en esa lectura** — río arriba del `CASE`, que entonces elige correctamente entre
dos valores ya enmascarados.

**Consecuencia: `ve_pii` no concedía nada, y nada lo gritaba.** Una persona con derecho veía `xxxx`
sin poder distinguirlo de «no traigo el claim».

**No hay fuga.** Falla cerrado: se pierde una capacidad, no se filtra PII. Y **la instancia de
referencia corre 0.18.0**, anterior a la vista de máscara, así que nunca consumió la superficie
afectada. Alcanzó a **0.19.0, 0.20.0 y 0.20.1**, publicadas y no consumidas.

**Lo que se corrigió no es el `CASE`: es la asignación de planos.** Hay dos planos de identidad y
cada uno tiene una sola capa capaz de gobernarlo — la **persona** (claims, por consulta: RLS + vista)
y el **principal de máquina** (roles y DDM, por conexión). El defecto fue **cablearlos en serie**
sobre el mismo camino de lectura. El DDM **se conserva** con su papel real —cubrir a principales que
no son Vergis—, y la decisión por persona vuelve entera a la capa que evalúa por consulta.

### El centinela: la precondición se mide, y su ausencia es ruidosa

El emisor instala `[<schema>].[vergis_unmask_probe]` cuando emite plano de columna: una fila, una
columna enmascarada, un valor conocido por construcción. El gate de servibilidad lo sondea **por
conexión** —la granularidad real de la capacidad, que se fija al conectar— y su lectura da **tres
estados que nunca se colapsan**: valor esperado (capacidad presente), otro valor (capacidad **medida
ausente**), o error (**no se pudo medir**, que jamás es veredicto).

- El centinela es **compartido por schema** y **no se retira** con el teardown de una tabla; se
  instala con **crear-si-falta**, nunca tira-y-recrea (`DECISIONS.md` D-46).
- **Sin centinela instalado** el gate declara **indeterminación**, no veredicto: un PI que ya servía
  conserva su veredicto sano y la remediación va escrita en el motivo (D-47).
- El sondeo viaja en la **misma ola** de consultas del arranque en frío: no agrega latencia (D-48).

**Diagnóstico gratis:** la vista enmascara con `•••` y el DDM con `xxxx`, **distintos a propósito**.
Un `xxxx` visto a través de Mira significa *capacidad ausente*; un `•••`, *persona sin derecho*.

### El despliegue de referencia conmuta entre anillos: desplegar deja de exigir una ventana (#210 · I7+I8)

> **Esta entrada se declaró después del corte, y consta.** El código de este frente (#233) viajó en el
> tag `v0.21.0` —verificado: `git merge-base --is-ancestor f6b1295 v0.21.0`— pero el corte del CHANGELOG
> lo dejó bajo «Sin publicar». La corrección lo devuelve a la versión que de verdad lo trae. **Lo que no
> se puede corregir**: la imagen `0.21.0` horneó el CHANGELOG sin esta entrada, así que para este
> tramo la fuente es el repo y no la imagen. Ver issue #242.

**Esto es un cambio del CONTRATO DE DESPLIEGUE**, no una capacidad del DSL: lo que cambia es cómo una
instancia estrena una versión. Hasta acá, adoptar una versión nueva era recrear el contenedor —con su
corte, su ventana de mantenimiento y su rollback caro—. El despliegue de referencia ahora trae un
**conmutador en el borde** y una **herramienta de ciclo de vida de anillos**: un anillo es una
instalación ejecutable de una versión publicada, y estrenar una versión es **trasladar el plano de
control y conmutar el borde en caliente**, sin recrear nada.

**Qué gana quien opera.**

- **`deploy/Caddyfile.reference`** (nuevo): el mismo Caddy expone un listener interno `:8079` que rutea
  al anillo activo leyendo `rings/active.caddy` —un archivo de **una línea**— y que trae la **sala de
  espera**: agotado el plazo de reintento, una página 503 con auto-refresh en vez del error crudo del
  navegador. Cubre lo **no planificado** (OOM, crash con `restart: unless-stopped`, arranque de un
  anillo frío), donde antes no había nada. La sala de espera vive en el **borde** porque nada dentro de
  un proceso puede cubrir su propia ausencia.
- **El health check del borde juzga por la FASE, no por el código HTTP**: sano ⇔ `200` **y** el cuerpo
  declara `"phase":"serving"`. Un nodo en espera responde 200 con `ok:true` por diseño, así que
  cualquier chequeo que juzgue por el código lo declararía sano y le rutearía tráfico de escritura que
  ese nodo contesta con 409.
- **`deploy/rollout/vergis-rollout`** (nuevo): `install / promote / rollback / retire / prune / status`.
  POSIX `sh` estricto —sin bashismos— y con solo `docker` y `sed` como dependencias. Un anillo se
  identifica por **versión + digest**: los tags móviles (`latest`, `main`, una serie) se rechazan, y
  volver a instalar una versión cuyo digest cambió **se niega** en vez de pisar lo instalado.
- **La promoción trae su propio pre-flight y su propio smoke.** El pre-flight compara el esquema de store
  que el candidato soporta contra el del archivo, leyendo el bloque `control` de `/contrato`: un
  candidato más viejo que el archivo **no se promueve**, y si el pre-flight no logra medir, **se niega**
  en vez de suponer. Después del flip, un smoke por el borde con el mismo predicado; si falla, la
  promoción **se revierte** por el mismo camino.
- **`RINGS_RETAIN`** (default **3**) es el total de anillos en disco: **`2` es blue-green exacto**. El
  **activo y el previo son un piso inviolable** — ninguna combinación de flags los retira. Calientes
  siempre dos (activo + previo); el resto queda en disco, y volver a uno cuesta un arranque que la sala
  de espera convierte en latencia, no en error.
- **`oauth2-proxy` apunta al conmutador** (`http://caddy:8079`) y **no se toca en una promoción**: mover
  el SSO exigiría reiniciarlo, que es exactamente el corte que esto elimina. El gate de identidad no
  cambia: el conmutador solo proxya las cabeceras que el SSO ya inyectó, y `:8079` **jamás** se publica
  al host.

**Costo honesto, declarado.** Durante el traslado del plano de control (segundos) las **escrituras**
responden 409 explícitos; las **lecturas se sirven todo el tiempo** y el serving no se interrumpe.

**Límites declarados.** El plano de control asume **un host con FS local**. La sala de espera no cubre la
muerte del propio borde. El smoke verifica el predicado de salud y el índice, no la ruta de cada PI:
`/healthz` publica conteos, no slugs, y el invariante que sí se exige es `pis.serving == pis.total`.

### Qué exige esta versión

> **El principal con el que Vergis se conecta debe poder leer el valor real de las columnas
> gobernadas** — sus lecturas no deben pasar por la máscara del DDM.

- **Cómo se concede es decisión del operador.** En Fabric, medido: lo decide el **rol del workspace**
  (`Member` lee el valor real, `Viewer` lee la máscara). `GRANT UNMASK` granular **no está medido**
  en Fabric. *[Medido después del tag — ver 0.22.0 · E3 y #245: `GRANT UNMASK` por columna funciona
  en Fabric y es la vía recomendada; la doctrina vigente vive en `docs/gobierno-permisos.md`.]*
- **El Producto verifica la capacidad, no el mecanismo.** No pide un rol concreto: mide si la lectura
  desenmascara.
- **Hay que regenerar y re-aplicar la DDL de la política**: el centinela nace con ella. Hasta
  entonces, un PI con reglas de columna que ya servía **sigue sirviendo** (indeterminación), y uno
  nuevo queda no-servible con la causa nombrada.
- **Verificación de que surtió efecto:** el PI con reglas de columna sirve, y un sujeto con el claim
  ve el valor mientras uno sin el claim ve `•••`. Si ve `xxxx`, la capacidad **no** está concedida.

⚠ **Y una advertencia que vale al operar el rol, medida el 2026-08-19:** conceder el rol propaga a
una conexión nueva en **≤11 s**, pero **revocarlo no propagó en >20 min** (techo sin medir), y ni una
conexión nueva ni un token nuevo lo destraban; una conexión ya abierta no lo ve nunca dentro de la
ventana medida. **Conceder es casi inmediato; quitar, no.** Si se revoca, hay que reciclar el
serving en vez de confiar en que el motor propague.

### Lo que sigue sin medirse, dicho con esas palabras

- Que `GRANT UNMASK` granular funcione en **Fabric** (sí está medido el rol de workspace). *[Medido
  después del tag — ver 0.22.0 · E3 y #245.]*
- Cuánto **dura** la staleness de revocación y qué la termina — solo hay cota inferior (>20 min).
- Que la aptitud medida al conectar valga **toda** la vida de la conexión: medido a 60 s, no más.

Lo que **sí** está medido, en el arnés local con la DDL emitida y control positivo: con la capacidad
presente la vista **discrimina** por claim, y **ninguna de 9 construcciones T-SQL** —cómputo
intermedio, `CROSS APPLY`, CTE, subconsulta, agregación, materialización en `#temp`— obtiene el valor
real sin ella. Corrobora; no demuestra imposibilidad.

## 0.20.1 — 2026-08-18

**Una corrección sola, sin capacidad nueva: las instrucciones de una versión ahora viajan con la
imagen.** Es la primera versión que las trae — las anteriores se construyeron antes del arreglo.

### El operador puede preguntarle a la imagen qué exige (#229)

El `CHANGELOG.md` va **dentro** de la imagen (`/app/CHANGELOG.md`) y los labels OCI dejan de estar
mudos: `org.opencontainers.image.description` —que venía **vacío**— y
`org.opencontainers.image.documentation`, que apunta a las notas de la versión.

```bash
docker run --rm --entrypoint cat ghcr.io/gegolabs/vergis:0.20.1 /app/CHANGELOG.md
docker buildx imagetools inspect ghcr.io/gegolabs/vergis:0.20.1 --format '{{json .Image}}'
```

**Por qué es una Z y no una Y:** no agrega capacidad ni cambia comportamiento — el servidor es
byte-por-byte el mismo que 0.20.0 salvo un archivo de texto y dos etiquetas. Existe para que un
operador pueda tomar **esto** sin evaluar nada más.

**Qué NO alcanza, y conviene saberlo antes de contar con ello:** las versiones **anteriores siguen
mudas**. Medido contra el registry: `:0.18.0`, `:0.19.0` y `:0.20.0` devuelven `documentation`
ausente y no traen el archivo. Un runbook que recorra **versiones intermedias** —que es lo correcto
cuando se salta de la que corre la instancia a la nueva— tiene que tratar el **repo como fuente** y
la imagen como comodidad; desde 0.20.1 en adelante, la comodidad existe.

## 0.20.0 — 2026-08-18

**Los dos planos que 0.19.0 dejó puestos ya están cableados: con dos nodos vivos, exactamente uno
escribe.** Un solo cambio (PR #225), y es el que vuelve utilizable lo que la versión anterior publicó
inerte.

**Lo que un operador tiene que saber para decidir:** un **nodo suelto se comporta igual que antes** y
ninguna variable de entorno es obligatoria. Lo que cambia es qué pasa cuando **conviven dos** —durante
una promoción, un recreate o un despliegue sin ventana—: aparece una fase nueva (`standby`), un código
de rechazo nuevo (409) y el trabajo de fondo deja de correr en todos los nodos a la vez. Sin
migraciones que correr a mano.

> ⚠ **Una advertencia que no está en el cambio y sí en cómo se lo vigila.** Un nodo en `standby`
> responde **HTTP 200 con `ok:true`** — sano, sirviendo lecturas, sin controlar. Cualquier chequeo que
> juzgue por «¿responde?» lo dará por bueno: el `healthcheck` de `docker-compose.yml`, por ejemplo,
> evalúa `r.ok` y marcará **healthy** a un nodo que no está sirviendo escrituras. Hoy no muerde
> —`deploy/compose.reference.yml` no declara healthcheck y su `depends_on` no usa
> `condition: service_healthy`— pero **muerde el día que algo enrute por salud**. El predicado
> correcto, y está escrito en el propio código, es **`200 ∧ phase=serving ∧ pis.serving=N`**.
> Detectado revisando este PR; no es un defecto suyo — ese healthcheck es anterior.

### El cableado que invoca los dos planos: un solo nodo escribe, el otro sirve lecturas (PR #225 · #210 I4+I5+I6)

**Esto cierra la frase de 0.19.0.** Ahí los dos planos quedaron *puestos y sin cablear* —era cierto de
esa versión y su entrada no se toca—; este cambio es **el cableado**, y con él el lease deja de ser una
pieza que nadie invoca.

**Qué cambia para quien opera.**

- **Los cinco lazos de fondo cuelgan del plano de control**: re-ingesta, purga, frescura, vigilancia de
  cargas y reporte periódico se arman **en el acto de adquirir** el control y se desarman al soltarlo,
  esperando el tick en vuelo. Un nodo sin control **no observa, no reconcilia contra el motor, no
  consume archivos del landing, no purga y no reporta** — lo que evita, con dos nodos vivos, dos
  controladores compitiendo por los mismos recursos externos y dos correos del mismo reporte.
- **`healthz` gana la fase `standby`**: HTTP **200** y `ok:true`, pero **distinta de `serving`**. El
  predicado del conmutador y del poller de cortes (`200 ∧ phase=serving`) **no** la satisface, que es
  justamente el punto: a un nodo en espera no se le rutea tráfico de escritura. La precedencia es
  `starting → standby → degraded → serving`.
- **Las mutaciones contra un nodo en espera responden 409**, nombrando al nodo activo y su época, en
  las superficies de administración, configuración de PI, notas y Miranda. Las lecturas se sirven
  normalmente: un nodo en espera **sí** sirve.
- **`/contrato` declara el bloque `control`**: modo, lease (titular, época, renovación, motivo si se
  perdió), anillo, estado de los lazos y **la lista de stores embebidos** con su versión de esquema
  soportada y la del archivo — en plural, porque una instalación tiene más de uno y un solo par de
  números escondería al store que bloquea un rollback.
- **`SIGUSR2` = «suelta el control y queda en espera»** (desarma lazos → volcado final → release), y
  **`SIGTERM` ahora suelta el control antes de cerrar**, dejando la marca que le ahorra al sucesor la
  ventana de staleness.

**Qué NO cambia para un nodo suelto.** Con `VERGIS_CONTROL=single` el comportamiento es el de siempre.
Con el default (`lease`) un nodo solo adquiere su lease al arrancar y sigue igual; lo observable nuevo
es el archivo `${VERGIS_OUT}/control.lease.json`, las líneas de log `[control]` y el bloque nuevo del
contrato. Ninguna variable de entorno es obligatoria.

**Cómo se verificó, y qué NO se midió.** Dos nodos reales sobre el mismo volumen y **sin una sola
petición**: exactamente uno arma los lazos, el estado del nodo en espera **nunca aterriza** en el
archivo de gobierno, el nodo en espera responde `phase: standby` y **409** a una mutación, y no aparece
ni un aborto por escritura concurrente. Con el plano apagado en ambos nodos, **los dos** declaran
`serving` y aparecen abortos en el que quedó atrás. El relevo se midió por señal (**≈8 s**) y por
muerte del activo (**≈10–12 s**, una sola corrida: corrobora, no caracteriza). **Sin medir:** el ancho
de la ventana de gracia del release frente a un candidato lento en arrancar; que un `GET` de las
superficies de gestión nunca escriba (revisado por patrón, no auditado ruta por ruta); y el
comportamiento sobre volumen de red, que sigue **fuera de contrato**.

## 0.19.0 — 2026-08-18

**El plano de columna vuelve a proteger, el gobierno deja de secuestrar columnas, y dos planos del
despliegue por anillos quedan puestos sin cablear.** Cuatro issues (#197 #164 #220 #222), de dos
frentes de trabajo distintos.

**Lo que un operador necesita decidir con esto:** las dos primeras son **correcciones de algo que hoy
no cumple lo que promete** —la máscara por sujeto no protegía a nadie en Fabric, y el gobierno de una
tabla pública bloquea `ALTER` sobre una columna de negocio elegida por accidente—; las dos últimas
**no cambian el comportamiento de un nodo suelto**. No hay migraciones que correr a mano. Hay
variables de entorno nuevas, todas con default y ninguna obligatoria. **Hay un cambio de contrato**
(`bindColumn`) y **una acción de migración que no es opcional para obtener el efecto de #164** —
ambos dichos abajo con sus pasos.

### Dos planos del despliegue por anillos versionados, puestos y **todavía no cableados** (#220, #222)

**Qué traen.** El store embebido gana un **plano de escritura único** —gate de versión de esquema por
`PRAGMA user_version`, y fencing que aborta el volcado si el archivo vigente cambió bajo el handle— y
el Producto gana un **plano de control único**: un lease sobre `${VERGIS_OUT}/control.lease.json` con
época, relevo por staleness y release ordenado, de modo que cuando dos nodos convivan durante una
promoción, **exactamente uno** posee el control y quién lo posee es un hecho verificable en un
archivo.

**Qué NO cambia para quien opera hoy, y es lo que importa leer:** los dos planos existen y **nada los
invoca todavía**. Los lazos de fondo, la fase `standby` de `healthz`, el 409 de mutaciones sin
control y el bloque `control` del contrato llegan en frentes posteriores. Un nodo suelto se comporta
**igual que antes**; `VERGIS_CONTROL=single` lo declara explícitamente y `lease` es el default de la
caja. No hay migración que correr ni env que agregar.

**Dos cosas que sí conviene saber antes de que la serie cierre:**

- Un archivo de store que declare una **versión de esquema mayor** que la soportada se **rechaza al
  abrir**, sin tocarlo — la incompatibilidad aparece en el pre-flight, no después de conmutar. Un
  archivo en versión `0` se adopta como legado y se respalda una vez a `<archivo>.pre-<versión>.bak`.
- El lease asume **un host con FS local** (rename atómico y relojes del mismo kernel). Está declarado
  en el propio módulo y acota dónde este mecanismo vale.

Variables nuevas, ambas con default y ninguna obligatoria: `VERGIS_CONTROL`
(`lease` | `single`), `VERGIS_LEASE_STALE_MS` (10 000) y `VERGIS_LEASE_RENEW_MS` (2 000). Un valor
desconocido en `VERGIS_CONTROL` **lanza** en vez de asumir.

### El plano de columna vuelve a proteger en Fabric (#197)

La **vista de máscara** (`vw_mask_<tabla>`) se creaba en Fabric y **ningún `SELECT` sobre ella
funcionaba**: el plano que hace que una columna sensible se sirva *a quien corresponde* no protegía a
nadie, y lo que quedaba en pie era el DDM de la tabla, que enmascara para todos. Corregido: los
claims del request se materializan en una fuente escalar de una fila y el `CASE` de cada columna lee
esa fuente, en vez de llamar a `SESSION_CONTEXT()` sobre el scan.

**Medido** contra el SKU F2 con el SQL que emite el compilador: la vista se crea, sirve y
**discrimina** por claim. **Lo que sigue sin medirse**: si el service principal de serving tiene
`UNMASK`. Sin ese permiso, la rama «en claro» de la vista recibe el default del DDM y **ni el sujeto
con el claim ve el valor** — es dirección segura, pero no es lo que la capacidad promete.

### El `grant: all` deja de tomar rehén a una columna de negocio (#164)

**Qué cambia.** La security policy de una tabla `grant: all` ya no ancla en una columna de datos: la
función del predicado no recibe parámetro y el `ADD FILTER PREDICATE` va sin argumento. Antes,
`WITH SCHEMABINDING` convertía esa columna en dependencia dura y **bloqueaba cualquier `ALTER` sobre
ella** — una columna elegida por accidente por el aplicador (`barcode`, `n_guia`, `anio_mes`,
`especie`, `tipo_material`, `pais_destino` en la instancia de referencia).

Medido en los dos motores con el SQL emitido, incluido el control que decide: **con la policy
instalada, el `ALTER` sobre una columna de negocio ahora se acepta**.

**Qué hay que hacer, y no es opcional para obtener el efecto.** Los artefactos ya desplegados siguen
funcionando exactamente igual —la apertura sigue siendo apertura, ninguna fila cambia de visibilidad—
pero **conservan su ancla**: la columna sigue siendo rehén en el motor hasta que la policy se
regenere y se re-aplique. Para cada tabla `grant: all`:

1. **Regenerar** el DDL de push-down con esta versión del Producto.
2. **Re-aplicar** el `setupSQL` completo de esa tabla. El setup dropea la policy anterior antes de
   crear la nueva, así que la liberación ocurre en ese acto y no hace falta nada más.
3. **Verificar** con un `ALTER` sobre una columna de negocio de la tabla: si pasa, el ancla se soltó.

**Y una advertencia que hay que leer aunque no se re-aplique todavía:** el compilador declara sus
dependencias de esquema (`schemaDependencies`) según lo que **emite**, no según lo que hay
instalado. Con esta versión, un `grant: all` reporta **cero** dependencias. Si la policy vieja sigue
desplegada, su columna **sigue atada en el motor y ya no aparece en ese reporte** — o sea que el gate
de regresión de terreno dejará de advertirlo y el bloqueo volvería a descubrirse con un `ALTER`
rechazado, que es exactamente como se descubrió la primera vez. **Mientras no se re-aplique, no
confiar en ese reporte para las tablas `grant: all`.**

**Cambio de contrato:** `FabricTarget.bindColumn` fue **retirado**. Un aplicador que todavía lo pase
recibe un error de compilación con su remediación —no se ignora en silencio, porque el silencio le
dejaría creer que su ancla sigue en pie.

## 0.18.0 — 2026-08-17

**Cuatro afordancias que el lector maneja, y una que deja de exigir un despliegue.** Cinco issues
(#203 #207 #209 #210, más el arnés de #197), los cuatro primeros nacidos de pedidos del cliente en la
weekly del 14-ago de una instancia real. Tests 2155 → 2203.

- **Las series de un `distribution` pueden salir de una COLUMNA** (#203, pieza 2). `metrics[]` es
  formato ancho con etiquetas fijas: sirve cuando las series se conocen al escribir el spec, y no
  sirve cuando salen del dato — el caso de PI-25, donde las series son (año × tipo), el año lo elige
  el usuario en runtime, y hubo que pre-plegar seis columnas en el SQL. `series: <campo>` agrega el
  formato **largo**: cada fila es `(categoría, serie, valor)`. El pliegue largo→ancho vive en
  `compose`, así que el render agrupado se reutiliza **entero** — apilado, rótulos, cota top-N y
  `sort` se comportan idéntico en los dos modos por construcción, no por dos implementaciones que
  haya que mantener de acuerdo. Cota de 8 series (el tamaño de la paleta: por encima los colores se
  ciclan y dos series distintas se dibujan iguales), con el excedente agregado en «(otras)».
- **El color de magnitud de las tablas es del LECTOR, y su rampa deja de ser roja** (#210). Pintaba
  `hsl(8, 75%, L%)` —hue 8 es rojo— oscureciendo a medida que el valor crecía: *la cifra más grande
  era la más roja*. En un informe de negocio el rojo significa «malo», no «mucho»; el cliente lo leyó
  así y la instancia terminó retirando los 44 `colorscale` de sus 7 specs, porque apagar la feature
  entera era la única salida que existía. Ahora la celda emite su **posición** en la rampa y el color
  solo se pinta con el interruptor de la bandeja, **apagado por defecto** y persistido por reporte.
  La rampa la fija el theme. `colorscale` del spec conserva un rol honesto: **acota** las columnas
  candidatas; lo que pierde es el poder de encender, que pasa al lector.
- **Los filtros de bandeja con catálogo grande se pliegan y se buscan** (#209). Tope de 12 opciones
  visibles más un buscador local. El plegado es **CSS-only** —un checkbox y una regla de hermano
  general—, así que **sin JS ninguna opción queda inalcanzable**; el buscador sí necesita JS y
  degrada a «no filtra», nunca a «no se puede llegar». Una opción **seleccionada nunca se pliega**:
  esconder la propia selección del usuario es peor que la lista larga. La medición previa corrigió la
  premisa y conviene saberlo: `.faceta-options` ya acotaba su alto a 220px con scroll, así que *un*
  filtro nunca ocupó la columna entera — lo que pesa es que N filtros suman N franjas, y que dentro
  de 47 opciones la que se busca se encuentra scrolleando a ciegas.
- **El nombre visible de un PI se edita sin desplegar** (#207). `identity.display_name` vive en el
  YAML: cambiarlo exigía editar el archivo y desplegarlo, o sea que renombrar un reporte era una
  operación de ingeniería. Ahora se edita desde la configuración del PI, con el gate de colaborador
  —el mismo que la demanda de frescura—. El override vive en el gobierno y **gana** sobre el spec,
  pero el nombre del YAML se conserva y la consola dice que está sobrescrito, contra qué, y quién lo
  hizo: un override mudo convertiría el spec en una fuente que miente para el que lo lee. **La URL no
  se mueve**, y no por cuidado sino por construcción — el slug sale de `identity.code`, jamás del
  nombre.

### Lo que NO trae, y se dice con esas palabras

- **#197 sigue abierto y su defecto sigue vivo.** La vista de máscara que emite el plano de columna
  se crea en Fabric y **ningún `SELECT` sobre ella funciona**. Esta versión **no lo arregla**: agrega
  el experimento que decide el rediseño (`fab:proof` · P6, tres formas candidatas con sus controles),
  y no toca el compilador hasta que ese experimento corra contra el SKU. Emitir una forma nueva sin
  verla pasar es exactamente lo que produjo el defecto.
- **Sin migraciones, sin env nuevo.** La tabla `pi_display_name` la crea el propio arranque
  (`CREATE TABLE IF NOT EXISTS`), como el resto del gobierno.
- **Capacidades sin verificar contra motor vivo:** ninguna de esta versión toca el motor. Lo que
  queda sin evidencia es de otra naturaleza y está dicho en cada issue — que las afordancias nuevas
  resuelvan el roce **para quien lo reportó** lo demuestra su uso, no la suite.

## 0.17.0 — 2026-08-14

**La autoridad se puede quitar, el alcance se puede acotar, y lo que toca Fabric por fin se mide.**
Cuatro issues (#182 #183 #185 #163), tres de ellos nacidos de casos reales de una instancia. Tests
2101 → 2125.

- **Un admin sembrado se puede revocar, in-app y sin reiniciar** (#182). La siembra de
  `VERGIS_ADMIN_SEED` era un upsert sin `DELETE` ni tombstone: quitar el correo del env no revocaba
  nada y la UI rechazaba la baja con 409, así que el único camino era **detener el contenedor y
  editar el `.sqlite` a mano** — con corte de servicio y sin rastro de auditoría. Ahora la baja deja
  tombstone (`admin_seed_removed`), el re-sembrado del arranque siguiente no la resucita y un alta
  posterior levanta la marca. Es la **misma precedencia runtime-sobre-semilla** que el store ya tenía
  para miembros de grupo y para el registro de fuentes (#107): `admin` era la única de las tres
  familias sembradas sin ella. Se conserva el único lockout real —no quitar al último admin—, que era
  lo que la inmunidad de la semilla venía confundiendo con protección. La UI advierte el **drift**
  cuando la identidad revocada sigue declarada en el env.
- **`stewards:` admite grupos de Mira, no solo correos** (#183). El único camino grupo→steward era
  `VERGIS_DEFAULT_STEWARD_GROUPS`, y es **todo o nada**: en una instancia real, para que un equipo
  gestionara la ingesta de UN dominio, sus seis integrantes quedaron steward de los **siete**. Una
  entrada de `stewards:` ahora **declara** qué es —`ana@gh.cl` o `group:feeders_cartera`—, nunca se
  infiere del texto. La **pertenencia se resuelve por request** contra el store, así que un alta o
  baja en `/admin/grupos` surte efecto **sin reiniciar ni recargar el YAML**. Fail-closed en los tres
  bordes: grupo inexistente, grupo vacío, o llamador que no resolvió los grupos ⇒ ningún acceso. Las
  dos vías de grupo son **unión**: `VERGIS_DEFAULT_STEWARD_GROUPS` sigue igual.
- **Comentar una fila deja de dar 403 cuando el alcance viene de un `default:`** (#185). El bloque de
  contexto que la capa de notas publica al cliente se armaba con la **query de navegación**, y un
  control de alcance con `default:` se resuelve server-side: con la URL pelada el bloque salía sin la
  llave `ctx`, el POST del comentario viajaba sin alcance y el gate re-buscaba la fila con el
  parámetro en blanco → cero filas → *«Registro no visible para esta identidad»* sobre una fila que la
  identidad **sí** ve. Ahora se publica el ctx **efectivo**, el mismo con que corrieron las queries de
  la página. **No se tocó el gate**: la llave inexistente sigue dando 403.
- **El control por COLUMNA instala, es idempotente y diagnostica** (#163). Tres defectos, los tres
  **medidos contra un motor** y ninguno deducido: (a) el guard de idempotencia del `DROP MASKED` **no
  guardaba** —T-SQL compila el batch antes de ejecutarlo—, y como ese statement encabeza el setup,
  **toda instalación nueva del plano de columna fallaba en su primera sentencia**; (b) un objeto
  `SCHEMABINDING` que referencia la columna bloquea el `ADD` y el `DROP MASKED` — el caso de las
  **vistas-contrato**; (c) el motor rechazaba con «one or more objects access this column», que no
  nombra al culpable ni dice qué hacer. Ahora un **preflight** diagnostica antes, nombra los objetos
  que atan la columna y da la salida **medida**: no es incompatibilidad, es **orden** —la máscara se
  aplica antes de crear el objeto, y el objeto se recrea después—. Falla ruidoso a propósito: el
  plano de **fila** ya quedó instalado, así que el corte es exactamente el de columna.

**Cómo se midió, que es la parte que cambia de aquí en adelante:** el Producto ganó un **terreno
T-SQL propio** (`npm run lab:up && npm run lab:proof`) — un motor real en contenedor, local y sin
tocar infraestructura de nadie, que aplica el DDL **que emite el compilador**, no SQL escrito para la
ocasión. La justificación que sostenía siete pendientes —«no hay dónde medir lo que toca Fabric»—
resultó **falsa para la semántica del lenguaje**. Sigue siendo cierta para el SKU de Fabric, los
permisos de un service principal concreto y el costo de enforcement.

**⚠ Nota de despliegue — un cambio de conducta observable al arrancar.** El parseo de `domains.yaml`
se vuelve **estricto**: una entrada de `stewards:` que no sea un correo válido ni `group:<slug>`
**falla al arrancar** en vez de quedar muerta en silencio. Es deseable —esa entrada era una
autorización que la instancia creía tener y no tenía—, pero conviene revisar el `stewards:` de cada
dominio **antes** de tomar la versión. Sin otros cambios de configuración ni de contrato de instancia;
`admin_seed_removed` nace sola en la apertura del store y una db anterior la estrena vacía.

**Lo que queda sin medir, dicho con esas palabras:** que **Fabric** se comporte como el motor donde
se midió #163. La asimetría es la que importa: un **negativo** del terreno T-SQL refuta también para
Fabric, pero el preflight y su remediación son **positivos**, y un positivo no garantiza el SKU. Y
para #182/#183/#185, ninguna corrida ejercita el proceso completo contra una instancia viva — eso lo
corrobora quien opere la versión.

## 0.16.1 — 2026-08-14

**El contrato operativo dejaba de mentir hacia el lado que cuesta downtime** (#139). Corrección sin
capacidad nueva: quien corra 0.16.0 puede tomar esto aislado, y quien todavía no la haya desplegado
debería tomar **0.16.1** directamente — un solo despliegue en vez de dos.

- **`GET /contrato` persistía una clasificación falsa de la env recargable.** La observación del
  arranque corría **antes** de que el bloque de hot-reload registrara sus watches, y
  `env.reloadableContent` se **deriva** de esos watches: la proyección persistida clasificaba
  `VERGIS_POLICIES` (y las demás claves vigiladas) como `bootOnly`. O sea, el contrato afirmando
  *«esto exige reiniciar»* cuando ya no — **el error de costo asimétrico que #139 existe para matar,
  cometido por el mecanismo que lo iba a matar**. Una regla que pide más cautela de la necesaria no
  falla nunca: solo cobra un corte de servicio cada vez.
- **Consecuencia para el delta entre versiones:** contra una referencia que nadie hubiera sanado con
  una consulta a `/contrato`, un despliegue donde nada cambió reportaba `nowReloadable` — un delta
  fantasma en el campo que el issue declara el más valioso.
- **El arreglo no depende del orden del arranque**: la observación va al final del cableado y, además,
  cualquier declaración **tardía** (`watch`/`signal`/`caveat`) re-observa sola, así que un orden
  equivocado se sana sin esperar a que alguien consulte el endpoint. El journal no toca disco si la
  huella no cambió; el registro del contrato sigue sin conocer al journal.
- **Medido, no leído**: las cuatro piezas —la clasificación falsa, la proyección completa, la
  convergencia que se había observado en producción y el delta fantasma— tienen su experimento con el
  registro y el journal reales (`tests/contract-boot-projection.test.ts`), con control de refutación
  corrido. Tests 2095 → 2101.

**⚠ Nota de despliegue**: sin cambios de configuración ni de contrato de instancia. Lo único que
cambia de conducta observable es que la entrada del journal del arranque nace completa; las entradas
ya persistidas por versiones anteriores se sanan solas en la primera consulta a `/contrato`.

**Lo que queda sin medir, dicho:** ningún test arranca el módulo `serve-rls` completo, así que que su
boot real observe al final está **leído, no medido**. La re-observación tardía es lo que vuelve ese
eslabón inofensivo.

## 0.16.0 — 2026-08-14

**El intake que se observa y la autorización que baja a la columna** — 70 commits sobre los issues
#161 #162 #163 #165 #159 #178, más dos CVEs y el frente de Renovate. Tests 1661 → 2095.

- **La plataforma observa sus propias cargas** (#161): un lazo de vigilancia clasifica cada slot y la
  consola dibuja el veredicto ya medido —jamás mide en el request path—. Lo que el requisito exige y
  la vista entrega es que el operador **distinga «no hay novedad» de «no pude medir»**: la calidad de
  la medida es un campo de primera clase (`fresca` · `ultima-conocida` · `contradice-registro` ·
  `ninguna`), un archivo que nadie tomó a tiempo se marca **VARADO** con su edad, y la vigilancia se
  declara por slot con un bloque `watch:` fail-closed (ausente = los defaults; `watch: false` es el
  opt-out total, con todas sus consecuencias escritas). Sin vigilante cableado, la consola renderiza
  exactamente la página anterior: regresión cero por construcción.
- **El fallo de una carga llega al usuario con su causa** (#162): desenlace por carga —`procesada`,
  `saltada`, `fallida`, `sin-informe`, `varada`— resuelto contra el log de la corrida que la cubrió,
  con el motivo textual que el job declaró (escapado y redactado: un log puede traer una cadena de
  conexión). Y el contrato `_logs/` que el error ya prometía queda **especificado** — con su aviso
  ruidoso cuando la instancia no lo cumple: sin log por corrida no hay causa por archivo, y el
  desenlace cae a «sin informe», que es la verdad y es cara.
- **Autorización por COLUMNA** (#163, nueve hitos): la política sabía esconder filas y el terreno
  ancho traía columnas que no se podían proteger. Ahora el compilador controla por columna, la vista
  de máscara es **servible** —el gate la reconoce corroborando en `sys`, no por el prefijo del
  nombre, que cualquiera con `CREATE VIEW` puede falsificar— y Miranda **nombra** la columna
  protegida en vez de sondearla. En ClickHouse la capacidad se declara **no soportada** y el PI no se
  sirve: ese back-end no controla la proyección, y fingir que sí sería servir dato sin protección.
- **El claim como conjunto** (#165): la doble pertenencia legítima —un sujeto que pertenece a dos
  zonas— negaba **en silencio**. La negación por cardinalidad del claim ahora se explica, y el
  rechazo de ClickHouse llega con el sitio donde ocurrió.
- **El mapa identidad→claims se administra desde la plataforma** (#159): deja de vivir en un archivo
  desplegado. Un cambio de claims era un despliegue; ahora es una escritura auditada.
- **La consola de Cargas navega por casilla** (#178): con más de un slot, una barra de pestañas —una
  por casilla, en el orden de `slots.yaml`— y **URL propia por casilla** (`?slot=<slotId>`), así que
  se le manda a alguien el link de la suya en vez de una instrucción de scroll. El rechazo ya no
  navega a Frescura: deja al usuario en su casilla y, cuando el archivo **sí** matchea el `accept`
  declarado de otra, el error la nombra y la enlaza. Sin candidato no se ofrece destino: cero
  heurística de parecido. Nace de un incidente medido —cinco cargas rechazadas en dos días, todas por
  el mismo motivo—, y con un solo slot la página es la de siempre.
- **Render**: el carril del rótulo de una serie lo decide la posición del punto, no el índice de la
  serie (#166); y el render de gráficos **no hace E/S** —ni de red ni de disco— por gate declarativo
  más un loader que niega. El subproceso para aislarlo se descartó **con medición**: el permission
  model de Node 22 no cubre la red.
- **Supply chain**: las dos CVEs de `ajv` y `yaml` corregidas a mano (#173); Renovate corriendo
  self-hosted con su cooldown de 14 días efectivo; y la política de tags de la imagen que encabeza
  este archivo, para que publicar sea un acto y no un efecto secundario de mergear.

**⚠ Notas de despliegue** — lo que el operador necesita para decidir:

- **La autorización por columna (#163/#165) está cerrada EN CÓDIGO y no se ha corrido contra un motor
  vivo.** Lo verificado es el SQL emitido y sus emuladores contra el oráculo. Cuatro preguntas siguen
  abiertas y la primera manda: si el Service Principal de serving **no** tiene `UNMASK`, la rama «en
  claro» de la vista de máscara recibe igual el default del DDM y la capacidad queda degradada a
  «esta columna no se sirve a nadie» — segura, pero no es lo pedido. **No apoyar una decisión de
  protección de datos en esta capacidad hasta medirla en el terreno de destino.**
- **#164 sigue abierto**: el andamiaje de RLS ancla su allow-all en una columna de datos, o sea que
  toma rehén al terreno. Está declarado y medido; no resuelto.
- **La vigilancia del intake (#161) no se enciende sola**: sin el lazo cableado en la instancia, la
  consola es la de antes. El aviso de incumplimiento del contrato `_logs/` exige que el convertidor
  de la instancia escriba su log al terminar (`docs/contrato-ingesta-logs.md`).
- **Recomendación de pin**: quien corra esto en producción debería referenciar `:0.16.0` (o su
  digest) en vez de `:latest`. Con la política de tags de esta versión, `:latest` ya significa «la
  última versión publicada» y no «el último merge» — pero un tag móvil en producción sigue
  significando que la próxima release entra en el siguiente recreate, sin decidirlo nadie.

## 0.15.0 — 2026-08-10

**El nodo que se explica a sí mismo** — 21 PRs (#140–#160) sobre los issues #107 #110 #111 #113
#138 #139. Tests 1409 → 1661.

- **Seguridad — el fix que cambia la postura**: cinco rutas de Miranda no verificaban dueño de
  sesión (#142). No eran las dos que el hallazgo original reportaba: además de `message` y
  `preview`, tampoco lo hacían `GET /miranda/s/:id` (transcript, intent, QC y draft completos),
  `validate-intent` y **`publish`** — cualquier identidad con scope podía publicar el draft ajeno
  como PI servido. Agravante: la lista SÍ filtraba por dueño, o sea que había **ilusión de
  privacidad** que la URL directa saltaba. Guard `dueño-o-admin` central en las cinco (404
  inexistente / 403 ajena; sesión legada sin `created_by` = solo-admin, fail-closed), con
  experimento de refutación: removido el guard, 10 tests caen. El gate del proxy pasa a
  comparación en **tiempo constante** (#160).
- **`GET /contrato` — el binario contesta «¿esto exige reiniciar?» y «¿tomaste mi archivo?»**
  (#139, N1 en #141 y N2 en #143). Derivado del estado, jamás declarado a mano: la misma llamada
  que instala un watch lo registra, y las claves de env se descubren corriendo `configFromEnv`
  sobre un Proxy que registra accesos —lo que además delata las presentes-y-jamás-consumidas—.
  `artifacts` compara sha256 de lo CARGADO contra lo que hay EN DISCO: distinto ⇒ `pending`.
  N2 agrega el **delta entre versiones** con journal por instancia, y `nowReloadable`/`nowBootOnly`
  como campos de primera clase: la reclasificación es el dato que invalida las reglas del operador.
- **Config recargable en caliente** (#138·2 fase 1, #151): `VERGIS_NOTIFY`, `VERGIS_PI_OWNERS` y
  `VERGIS_SOURCES` salen de la vía que exige recrear el proceso — watch por slice con
  validate-before-swap (un yaml roto conserva lo vigente y queda `ok:false` en el ring), `SIGHUP`
  recarga todo lo recargable, y la reclasificación `bootOnly→reloadableContent` aparece sola en
  `/contrato`. La respuesta del binario a «¿esto exige reiniciar?» cambió de «sí» a «no» para esos
  tres, y lo dice él mismo.
- **Publicación de definiciones de jobs en el motor** (#107 fase 2, #152–#158): autoría de items
  verificada contra el tenant real antes de construir, plantillas de job, publicación, superficie
  admin y wiring. La comparación es **canónica**, no byte-a-byte: el motor normaliza el payload
  (`""→null`, re-serialización) y compararlo crudo producía falsos negativos.
- **Miranda**: preview de RLS con **dos identidades de un roster declarado por instancia**
  (#145) — jamás impersonate libre, sin roster la superficie es cero, y cada render impersonado se
  audita con el actor real. Y se retira una promesa falsa: `MIRANDA_VALIDATE_CAPS` ofrecía
  `send-email`/`send-slack`, capabilities que no existen en el repo — Miranda validaba OK drafts
  que el serving rechazaba al registrarlos (#144).
- **Rendimiento del arranque en frío** (#140): medido que **no escala con N PIs** —
  `sourceStateOf` corre 1 vez por conexión, no por PI, y la evaluación por PI es pura en memoria.
  Lo único serial real eran las 2 queries de sistema por conexión; paralelizadas, 122,5 ms → 61,7 ms.
- **Gobernanza y supply chain**: ADR-002 fija el corte open-core antes de que lo fije el primer
  contribuidor externo (#146); catálogo de convenciones de plataforma sembrado en `rubric/` (#147);
  endurecimiento D8 de supply chain (#148), manifiesto de `packages/miranda` en el Dockerfile
  (#149) y fix de audit (#150). **Renovate pasa a correr self-hosted en el CI** (#160): el cooldown
  de 14 días del ADR-001 llevaba desde junio declarado pero inerte, porque instalar la GitHub App
  exige un acto humano que nunca ocurrió.

## 0.14.0 — 2026-08-06

**El barrido del backlog** — 15 frentes en una sesión (issues #61 #62 #63 #65 #66 #95 #99 #100 #101
#102 #105 #106 #107·f1 #108 #109 #114 #117; PRs #118–#134). Tests 1039 → 1409.

- **Observabilidad de ingestas completa**: log de cada corrida —fallida Y exitosa— desde el producto
  (#99, convención `_logs/run-<ts>.txt` en OneLake); proyección local `ingestion_run` — la vista de
  Frescura ya no toca el motor al abrirse, y con el motor caído sirve lo último conocido con
  staleness visible (#105); estado por proceso en la vista transversal de Fuentes (#101); avisos con
  destino declarativo (`VERGIS_NOTIFY`) y enlaces profundos (#100); reporte periódico por email
  **enviado siempre** — un día sin correo es señal de problema, no día tranquilo (#102, SMTP propio
  sin dependencias).
- **Intake transaccional**: registro de cargas en el GovernanceStore con pre-check de duplicado
  «¿Continuar?» y retro-indexado de `_processed/` (#62); «Revertir esta carga» de primera clase con
  plan sellado por hash y compensación por clave (#63); `options_ref` — catálogo de la instancia
  como fuente de opciones, dropdown con validación server-side (#109); metadata derivada del nombre
  del archivo por convención declarada (#95).
- **Gestión por rol, fase 1** (#107, issue abierto para la fase 2): fuentes/procesos/salidas
  gestionables in-app con precedencia sobre la semilla YAML (`managed_at` + tombstones), cadencia y
  pausa/reanudación desde Frescura.
- **Render**: chips de filtros activos visibles en el cuerpo del PI (#114); corte as-of «Datos
  al …» como convención de plataforma en el header — y «Generado» eliminado: dos renders del mismo
  dato son byte-idénticos (#108); export CSV con celda única cliente/delivery, anti formula-injection
  y fix de BIGINT con signo (#61); «Descargar PDF» server-side con sidecar WeasyPrint (#65).
- **Robustez y auth**: fail-closed ante la clave raíz ausente en los 8 YAML de instancia — «declara
  cero» (`clave: []`) sigue siendo legítimo; sin opt-out (#117); puerto `CredentialProvider`
  (secret/federated/imds) — el clientSecret deja de estar cableado en el código (#66).
- **Docs**: arquitectura multi-reporte y gobierno de permisos (#106).

**⚠ Notas de despliegue**: (a) #117 — verificar los YAML de la instancia antes de subir: un archivo
decapitado ya no arranca; (b) los modos passwordless de #66 no se activan sin sus gates manuales;
(c) gates manuales pendientes contra motor/canales vivos: contrato escritor de `_logs/` (#99),
rate limits del poll (#105), Slack (#100), relay SMTP (#102), sidecar PDF (#65), pausa real (#107),
contrato D8 del convertidor (#63).

## 0.13.0 — 2026-07-28

**La capa de notas — impresiones, anotaciones y comentarios** (vergis#84, cierra #60). Lo que una
persona dice sobre lo que ve tiene por fin dónde vivir. Doc:
[`docs/capa-de-notas.md`](docs/capa-de-notas.md).

- **Dos especies, no una.** El **comentario** se ancla a un REGISTRO gobernado (entidad + llave de
  negocio) y es el mismo se mire desde el PI que se mire; la **anotación** se ancla a una
  **impresión**: lo que viste, congelado tal como lo viste (filas, forma, recorte, watermark,
  versión del spec, autoría). Confundirlas produce un sistema que no sirve para ninguna.
- **El gate del comentario se verifica contra el DATO, al escribir** — el server re-ejecuta la
  recuperación del dataset bajo la identidad del autor y exige que la llave esté en el resultado. Un
  token firmado verificaría lo que el server dijo antes; una autorización revocada seguiría
  escribiendo. La lectura del hilo es igual de fail-closed.
- **`anchor` en el DSL** — el dataset declara `{ entity, key[], display? }`: identidad de negocio,
  jamás autorización (el spec sigue authz-blind). **Sin `anchor` el gesto no se ofrece** (404).
- **Impresión perezosa** — la primera anotación hace nacer la impresión sola; dentro de la sesión de
  trabajo (12 h) las notas del mismo sustrato comparten impresión. Se ve read-only y sin drills: es
  un documento, no una vista.
- **Compartición gobernada** — solo el dueño, auditada, revocable **hacia adelante**: el receptor
  pierde el acceso y sus notas persisten. El registro ES la fuente de «Compartidas conmigo».
- **«Mis impresiones»** en el menú del avatar — una capacidad que no se ve, no existe.
- **El motor jamás lee una nota**: el enriquecimiento corre tras componer, sobre el resultado ya
  cerrado; si falla, el PI se sirve idéntico. Las notas no viajan en el export CSV.
- **Envs nuevos** — `VERGIS_NOTES_DB` (default `<VERGIS_OUT>/notas.sqlite`), `VERGIS_CSRF_SECRET`.
  **Retirados** (se ignoran con aviso, sin imprimir su valor): `VERGIS_ANNOTATION_SECRET`,
  `VERGIS_ANNOTATIONS_DB`, `VERGIS_ANNOTATIONS_URL`.
- **Settings de plataforma** — retención de impresiones `P12M` (**se aplica**: purga al arranque y
  cada 24 h, medida desde la última actividad), envíos programados por usuario `10` y
  anti-cementerio `on` (declarados; se aplican cuando los envíos programados existan).
- **Retirado el esquema anterior de anotaciones** — la columna editable y los tokens HMAC por fila
  visible en cada render (≈850 firmas por carga, sosteniendo cero anotaciones) desaparecen junto con
  su store, sus rutas y su secreto. Sin migración: estaba vacío.

## 0.12.0 — 2026-07-15

**`VERGIS_DEV_IDENTITY` — identidad de desarrollo inyectable (fail-safe)** (work/087). En un despliegue
de dev **sin gate** (sin oauth2-proxy) ninguna request trae `x-forwarded-*` → identidad vacía → 403 en
toda superficie con scope, imposible de manejar desde el navegador. Este env inyecta una identidad fija
para **manejar Mira y los PIs desde el browser local** sin forjar headers por curl. Formato: `email` o
`email:grupo1,grupo2` (los grupos pueblan el claim `groups`). Doc:
[`docs/gobierno-permisos.md`](docs/gobierno-permisos.md) §«Identidad de desarrollo».

- **Seguridad (requisito #1): imposible de activar donde hay gate real.** La activación es
  `seteado ∧ ¬gate-real`; la señal de gate real es la presencia de `VERGIS_GATE_SECRET`. Con gate real
  presente el env **se ignora** (nunca inyecta) y se emite un warning al arranque — config contradictoria
  prioriza seguridad. Sin el env, comportamiento **idéntico a hoy** (test de regresión). La decisión vive
  en una función pura y testeada (`decideDevIdentity`); el header de gate, cuando existe, **siempre gana**.
- **Los tres caminos** — sin gate + env → una request sin header toma la identidad del env; con header de
  gate → el header manda (se preserva el 403/otras identidades por curl); sin env → sin cambio alguno.
- **Defensa en profundidad** — con `VERGIS_GATE_SECRET` definido, el gate A10 rechaza (403) toda request
  sin `x-gate-token` antes de resolver identidad, además de que el env queda inerte.

## 0.11.0 — 2026-07-14

**Miranda — agente conversacional que autora specs de PI** (cluster 077, Fase 1). Capacidad nueva del
Producto (`@vergis/miranda` + superficie `server/miranda.ts`): un especificador crea un PI nuevo
end-to-end conversando, sin tocar YAML — Miranda elicita → compila DSL → se auto-chequea (QC①
interiorizado, juez ≠ autor) → previsualiza con RLS real → publica. Doc:
[`docs/miranda.md`](docs/miranda.md).

- **Todo detrás del feature flag `MIRANDA_ENABLED` (default off)** — con el flag apagado, cero
  superficie nueva (ni rutas, ni nav, ni dependencias activas; `GET /miranda` = 404 idéntico a hoy).
- **Envs nuevos** — `MIRANDA_ENABLED`, `MIRANDA_MODEL` (default `claude-sonnet-5`),
  `ANTHROPIC_API_KEY`, `MIRANDA_RUBRIC_DIR` (monta `dsl.md`/`qc1.md`), `MIRANDA_CATALOG` (allowlist de
  probes), `MIRANDA_MAX_TURNS` (40), `MIRANDA_TOKEN_BUDGET` (500k/sesión), `MIRANDA_SCOPE_GROUP`
  (`miranda`), `MIRANDA_ANNOUNCE_WEBHOOK`. Scope `miranda` (403 sin él); autorización de la capacidad
  independiente de la RLS del dato (preview y serving pasan por el mismo `serve-rls`).
- **Sesiones en el governance store** — `miranda_session`/`miranda_message`/`miranda_artifact`
  (append-only, versión por artefacto) + `miranda_seq` (semilla **PI-101**). La sesión es el ledger
  de procedencia del PI, exportable a git.
- **`forma` por vista en el resumen de intención** (ajuste post-diseño, hallazgo PI-17/F-01) — el
  resumen que el usuario valida lleva `vistas[]` (`{nombre, forma: tabla|dashboard|mixta, piezas:
  [tarjetas|graficos|tabla]}`), haciendo la intención visual validable sin leer el DSL. El self-check
  cruza la forma declarada contra las piezas reales del draft (KPI/dato→tarjetas, chart/series/
  distribution→graficos, table→tabla): divergencia = brecha M. Enforcement en código
  (`crossCheckForma`), no solo prompt.
- **Gates en código** (no solo prompt): publish solo desde `autochequeado`, sin brechas B/M, con draft
  que valida contra el DSL; probes SQL por guardia (solo SELECT, TOP 500, allowlist de catálogo);
  authz-blind; secretos jamás en logs/transcripts.

## 0.10.0 — 2026-07-14

**Trío de primitivas del catálogo DSL** (work/081) — tres elementos de pieza nuevos con demanda real,
100 % aditivos (los specs existentes renderizan idéntico). Doc:
[`docs/catalogo-elementos.md`](docs/catalogo-elementos.md).

- **`dato`** (#71) — atributo rotulado (etiqueta + valor). Es contenido/estado, no una medida:
  tipografía de texto (distinto del `kpi`), se imprime tal cual y **jamás es interactivo**. El valor
  se resuelve por el mismo path que `kpi.metric`; `format: date` recorta ISO/`Date` a `YYYY-MM-DD`
  (reusa el helper de 0.9.0). Origen TX-12.
- **`distribution` multi-métrica** (#70) — `metrics` (2+ series) reemplaza a `metric` (singular) para
  **barras agrupadas**. El singular queda intacto; declarar ambos es error. `fold` + `color` por serie
  + `xOffset`/`yOffset`. La cota top-N ordena categorías por la suma de las series y colapsa «(otros)»
  sumando **cada serie por separado** (el total por serie cuadra). Origen TX-13.
- **`series`** (#69) — líneas de 1..N series sobre un eje. Formato wide + `fold`; `mark: line` con
  puntos. El eje x es ordinal en el **orden de llegada de las filas** (el SQL manda; no se re-ordena
  alfabético). Desviación vs doc §4.1: `time_field`/`granularity`/`range` NO se implementan — el eje
  lo modela la query (Gold-in-query), `x` reemplaza a `time_field`. Origen PI-17.
- **Themes** — token `chartSeries` (paleta categórica) en `default` y `arbol`, con fallback en
  render-chart. Charts multi-serie ciclan la paleta.
- **`narrative` / `alert` / `comparison`** — *diseñados, no construidos*: narrative lo definirá
  Miranda; alert requiere subsistema de delivery (su rol visual lo cubre `semaforo`); comparison simple
  ya lo cubre `kpi.comparison`. Ver `docs/catalogo-elementos.md` §4.

## 0.9.1 — 2026-07-14

- **Fix: etiqueta de display con `Date` del driver** — el driver mssql/tedious devuelve las columnas
  datetime como **objetos `Date` de JS**; `String(dateObj)` produce la forma larga («Tue May 26 2026
  00:00:00 GMT+0000 …») que esquivaba el recorte ISO→`YYYY-MM-DD` (visto en el sello-fecha de PI-07
  vivo). La normalización de etiquetas (`trimIsoLabel`/`buildControlOptions`) ahora trata
  `value instanceof Date` → `toISOString().slice(0, 10)` — aplica a las opciones del sello Y al span
  print de cualquier control cuyo `display` sea datetime.

## 0.9.0 — 2026-07-14

**Selectores de alcance por llave alternativa** (work/079) — extensión aditiva del sello de alcance de
0.8.0: un mismo alcance puede elegirse por **más de una llave**. Cada entrada de `controls:` gana dos
roles opcionales; sin ellos, el comportamiento es **idéntico a 0.8.0** (cero cambio a specs,
`serve-rls`, `applyCtx` ni a la semántica de URL). Doc:
[`docs/superficie-de-estado.md` §7](docs/superficie-de-estado.md).

- **`param`** (default = `id`) — a qué `ctx.<param>` escribe el control. Dos controles con el mismo
  `param` son **llaves alternativas** del mismo alcance: eligen por campos distintos, fijan el mismo
  `ctx.<param>` y la banda pinta **ambos sellos sincronizados** (elegir la fecha equivale a elegir su
  OC). URL intacta (`?ctx.<param>=…`).
- **`display`** (default = el campo de `source`) — qué campo del MISMO dataset se muestra como etiqueta.
  Las opciones se resuelven como pares `{value, label}` fila a fila (mapeo 1:1). Datetime ISO en la
  etiqueta → recortado a `YYYY-MM-DD`; colisión de etiqueta entre values distintos → desambiguada con
  `label (value)`.
- **Resolución y validación** — el **dueño** del `param` (1er control que lo declara) aplica el
  `default`; los demás heredan el valor vigente. Params compartidos exigen **mismo dataset** y `single`
  (rechazo con error claro si no); `display` colgante se rechaza como el `source` colgante.
- **(ii) cascada `narrows:`** — *diseñada, no construida*: el diseño de un control que acota las opciones
  de otro queda documentado en §7·2 sobre la misma base de opciones-como-pares.

## 0.8.0 — 2026-07-14

**Superficie de estado** (TX-11) — convención de plataforma: *cara = estado · gaveta = maquinaria ·
print = estado como texto*. Cambio de comportamiento visible en todos los PI, 100 % de superficie
(cero cambio al DSL, a los specs, al camino de datos ni a la semántica de URL — los links `?ctx.*`
compartidos siguen idénticos). Doc: [`docs/superficie-de-estado.md`](docs/superficie-de-estado.md).

- **El sello de alcance es clickeable** — la banda de contexto (`vctxbar`) deja de ser solo-lectura y
  se vuelve EL selector: un control single es un `<select>` nativo estilizado como sello; uno multi,
  un `<details>` con los checkboxes. Una cosa, un lugar: el control sale de la gaveta. En print, el
  sello degrada a texto plano.
- **Chips de filtro imprimibles como letra chica** — los filtros activos aparecen como chip removible
  en la cara solo al aplicarse, y en print se imprimen como texto discreto («Filtros: …»), ocultando
  solo la acción (la ✕). Agrupar-por no imprime chips. La maquinaria (pickers, búsqueda, agrupar,
  export, config) jamás se imprime.
- **Afordancias proporcionales y atribuibles** — una tabla que rinde 1 fila (single_row) es display
  puro: sin runtime, sin iconos de filtro, sin kit. El kit de afordancias (buscar · agrupar ·
  descargar · limpiar) es ÚNICO en el Inspector, con selector de objetivo solo si hay ≥2 tablas
  interactivas (jamás kits apilados). El contador de filas sale del kit y pasa a pie discreto de cada
  tabla en la cara (se imprime).

## 0.7.0 — 2026-07-13

- **Descargar CSV de la vista actual** (#61) — botón en la gaveta de tabla: exporta la vista
  (filtros/búsqueda/facetas aplicados), columnas visibles sin anotaciones, separador `;`
  (Excel es-CL) y BOM UTF-8. Decisión de instancia: CSV es la resolución del export (xlsx
  descartado; PDF server-side es #65).
- **Dedup de carga por contenido** (#62) — SHA-256 al subir vs historial del slot (el nombre no
  participa): idéntico → aviso sin bloquear + tag «contenido idéntico a X» en Actividad; el hash
  queda en el audit event. Badge **«sin cambios en el dato»** cuando el log de la corrida trae el
  marcador `[delta] sin cambios en el dato` (la emisión es del pipeline de la instancia).
- **«Revertir esta carga»** (#63, fase 1) — acción por archivo del histórico `_processed/<clave>/`
  (el layout es el ledger carga→clave): revertido → `_retirado/`; con versión previa de la clave,
  se reactiva y re-corre (last-wins restaura el estado anterior); sin versión previa, aviso honesto
  de dato sin origen (compensación del pipeline = fase 2). Auditado `intake-revert`.

## 0.6.1 — 2026-07-13

- **fix(render): los controles del Inspector navegan de nuevo** — el `onchange` generado usaba
  `new URL(…)`, que dentro de un handler inline resuelve contra `document.URL` (un string que
  sombrea al constructor) y lanzaba `TypeError` en todo browser real: el selector single/multi
  jamás navegó por clic (la URL directa `?ctx.*` sí funcionaba, por eso los probes no lo vieron).
  Ahora `new window.URL(…)` + test de regresión que ejecuta el handler bajo el scoping real de
  inline (`with(document)`), no solo su sintaxis. Reportado por la instancia GH (PI-01/PI-07).

## 0.6.0 — 2026-07-13

- **`oferta: evento`** — fuentes EVENT-DRIVEN de primera clase (la mejora que la instancia GH
  documentaba como pendiente): una fuente sin cadencia (cada llegada es un evento, p. ej. una OC
  por archivo) se declara honestamente sin fabricar una periodicidad. No impone piso a la demanda,
  el reconciliador no la agenda, su entidad aparece en Frescura con corridas y salud de falla, y el
  monitor alerta conversiones fallidas. Habilita registrar el proceso de PI-07 y cerrar su hueco de
  observabilidad (#56) sin datos inventados.

## 0.5.0 — 2026-07-13

La operación de cargas se vuelve una superficie de primera clase (issues #55–#58, todos
nacidos de la operación real de la instancia GH ese mismo día).

- **Consola de Cargas por dominio** (#58, `/admin/dominio/<id>/cargas`): línea de tiempo
  que correlaciona cargas de archivos (quién/cuándo/tamaño, del audit) con corridas de
  conversión (estado/duración/motivo); landing y archivo histórico (`_processed/`)
  navegables; **re-run** de la conversión, **retiro** de un archivo del landing (a
  `_retirado/`, reversible) y **reactivación** desde el histórico — el ciclo completo de
  rollback honesto para pipelines por-clave. Todas las acciones con CSRF + steward + audit.
- **Log de la última conversión visible** (#55): en Frescura y en la consola; el slot
  declara la ruta (`log`, default `Files/code/_ingest_log.txt`); lectura OneLake tolerante.
- **Coherencia declarativa** (#56): un slot cuyo trigger no está registrado como proceso
  en Fuentes se acusa ruidosamente (Frescura + consola) — era el hueco silencioso que dejó
  al slot de PI-07 sin observabilidad.
- **Residuos en el landing** (#57): archivos anteriores a la última corrida completada se
  marcan «se re-procesará», con retiro a un clic — la causa raíz del duplicado de datos
  del incidente PI-07.
- Capabilities: `OneLakeReader` gana `list`/`copy`/`remove`/`readBytes` (DFS).

## 0.4.0 — 2026-07-13

Cierre de los issues #50–#54 (todos reportados desde la instancia GH en beta): robustez
operacional del serving push-down y del gobierno de dominio.

**Serving (engine=fabric):**
- **Fail-closed por PI, no por proceso** (#52): la verificación de RLS nativa es por PI y
  consulta solo las conexiones en uso; un PI que no verifica responde `503` con motivo
  accionable y los demás siguen sirviendo. Indeterminación (conexión caída) conserva el
  veredicto sano previo; un veredicto definitivo siempre bloquea. `/healthz` distingue
  `starting`/`degraded`/`serving` con conteos `{total, serving}` (sin slugs: sigue reducido).
- **Herencia de gobierno vista→base** (#54): una vista-contrato `WITH SCHEMABINDING` sobre
  bases gobernadas sirve sin entrada propia en el policy store ni secpol duplicada; el
  linaje se resuelve en la fuente (certeza o nada, transitivo, fail-closed) y la herencia
  queda en el log del gate. La visibilidad del índice hereda igual.

**Gobierno de dominio:**
- **Hot-reload de conexiones, dominios e intake** (#50): `VERGIS_CONNECTIONS` acepta ruta a
  archivo (preferido: secretos fuera de `/proc`/`docker inspect`) además de JSON inline;
  los tres archivos recargan con validate-before-swap por archivo (uno malformado conserva
  su estado vigente). El alta completa de un dominio ya no exige restart.

**UX / correctness:**
- **Motivo de falla del job disparado visible** (#53): la celda «Última corrida» de Frescura
  y los slots de «Otras cargas» muestran el `failureReason` de Fabric (escapado, recortado) —
  quien carga un archivo ya no reintenta a ciegas.
- **`format: int_0` sobre strings numéricos** (#51): los `SUM(BIGINT)` que el driver entrega
  como string se formatean igual que los números; enteros sobre `MAX_SAFE_INTEGER` se agrupan
  sobre el string sin perder dígitos. Aplica a servidor y cliente (formateador único).

## 0.3.0 — 2026-07-07

Cuarta ronda de revisión (cluster `work/001`): hardening de seguridad, robustez y
divergencias de policy. Sin capacidades nuevas del DSL; el bump de Y refleja el
conjunto de correcciones de runtime/seguridad de las olas 1–3.

**Seguridad:**
- **`escapeHtml` escapa la comilla simple** — cierra la inyección JS en handlers inline y el escape del catálogo desde un solo lugar.
- **Gate de gobernanza del policy store**: se rechaza el `dataset` duplicado (el last-wins podía pisar la RLS) y las divergencias de backend (`COLLATE` binario en Fabric, guard de cardinalidad en `op: eq`, `CREATE ROW POLICY OR REPLACE`).
- **Intake**: nombre de archivo endurecido (sin traversal ni caracteres que rompan el path DFS) y codificación por segmento.
- **CSV**: neutralización de formula injection. **`.env`** fuera del build context; **8080** en loopback.

**Robustez:**
- **Escritura atómica** del store de gobierno (tmp+rename); **evict** de pools mssql envenenados; **timeouts** en todo fetch de red.
- **`expectString`** en la frontera de render (cierra el 200-en-blanco); **contrato insert/update** de master-data DWH; **`setDemanda`** validado con el parser real.
- **Validación DSL** de `agg.dataset`/`table.data` pelados (un typo ya no muestra 0 en silencio).

**Operación / CI:** `HEALTHCHECK` + rotación de logs + `mem_limit` en compose; permisos mínimos por job + `concurrency` en CI; pin de Actions/imagen por digest (Renovate); `engines: node>=22`.

## 0.2.2 — 2026-06-11

Hardening de runtime y de supply chain (sin capacidades nuevas del DSL). Ver
`docs/adr-001-lenguaje-y-supply-chain.md` y `docs/mejoras-diagnostico.md`.

**Supply chain:**
- **Lifecycle scripts bloqueados** (`.npmrc` con `ignore-scripts`) — ningún paquete ejecuta código al instalar.
- **vega 6 / vega-lite 6** — cierra dos HIGH (XSS, GHSA-7f2v-3qq3-vvjf y GHSA-m9rg-mr6g-75gm). `npm audit`: 0 vulnerabilidades.
- **Cooldown de updates** (Renovate, `minimumReleaseAge` 14 días; las alertas de vulnerabilidad lo saltan).
- **CI**: gate de `npm audit --omit=dev`, verificación del build, SBOM + provenance en la imagen.
- **Imagen multi-stage**: el server corre precompilado (`node dist/serve-rls.mjs`, sin tsx), con deps
  solo de producción, sin scripts y como usuario no-root.

**Runtime:**
- **Timeout por capability-call** (configurable, default 120 s) — una Capability colgada ya no cuelga la invocación.
- **Contrato de salida validado en la frontera**: una Capability de datos que no devuelve `{ rows: [...] }`
  falla ruidoso y accionable (`capability-output-invalid`), no críptico aguas abajo.
- **Límite de profundidad** en la composición de pieza (guard contra specs patológicas).
- **`mira-ctx-missing` en el log** cuando una query referencia `:ctx.<param>` sin valor (se bindea `''`, que acota igual).

## 0.2.1 — 2026-06-04

- **Versión del PI distinta de la de Mira.** El inspector muestra, por separado, la versión del **PI**
  (instancia, de `identity.version`, p.ej. `PI-01 · v1.1`) y la versión de **Mira** (motor, este
  `package.json`). Dos pistas de versión independientes: el motor evoluciona aparte de cada reporte.

## 0.2.0 — 2026-06-04

Primera versión con seguimiento explícito. Es lo **publicado y vivo** hoy (PI-01/04/12 en la VM).

**Nuevas capacidades del DSL (genéricas, por configuración):**
- **Controles de cabecera (`controls`):** selector single-select server-side que fija `:ctx.<id>` en
  las queries (cambia el dato, no solo la vista), con **default computado** (`max`=más reciente / `min`
  / `first`). El valor se preserva al navegar/drillear.
- **Multi-drill + clave compuesta:** `drillthrough` acepta objeto o arreglo; `by` acepta una clave o
  varias (p.ej. empresa+socio). Columna de acciones con N links etiquetados; con un solo drill se
  conserva el doble-clic de fila. El contexto se bindea (injection-safe) y **acota, nunca amplía**.

**Lineamiento de construcción:**
- Los **controles viven en el inspector** (gaveta, tab Controles), nunca en el cuerpo del reporte.

## 0.1.0 — línea base (walking skeleton)

Servidor RLS multi-PI por consumidor (motores ClickHouse / Fabric push-down, data-anchored,
default-deny), multi-vista + drill-through simple, tablas interactivas (orden/filtro/búsqueda/
agrupación/vistas guardadas), facetas de dashboard, anotaciones gateadas por HMAC, themes pluggables.
