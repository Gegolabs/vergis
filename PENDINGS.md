# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `PENDINGS-done.md` §vencidas. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

> **La regla del TTL y las fichas con dependencia externa (adoptada 2026-08-22).** El TTL corre
> **sobre las abiertas `[ ]`**: mide el silencio del agente, no el del acreedor. Una ficha `[~]` con
> **dependencia externa nombrada** (pagada, esperando a un tercero) **no vence por plazo** — hereda
> la exención de la cobranza-con-rehén de `TODO.md`, y su TTL se cuenta desde la última
> **re-derivación contra el estado vivo**, no desde su `reg`.

## Operación / despliegue

- **0.20.1 está publicada y NO se ha avisado al operador** (*act 2026-08-18: la ficha decía 0.18.0 y
  que #197 seguía vivo; las tres versiones del 18-ago volvieron falsas ambas cosas*) — tags
  `v0.19.0`, `v0.20.0` y `v0.20.1` empujados con sus imágenes verificadas en el log del workflow.
  **Nada quedó sin publicar**; falta el aviso, y **el acto es de César**: comunicación saliente a un
  tercero, que ningún presupuesto cubre. Lo que ese aviso tiene que decir, y es más que antes:
  (a) **#197 quedó corregido** — la vista de máscara ya sirve y **discrimina** en Fabric desde
  0.19.0; (b) **cambio de contrato**: `FabricTarget.bindColumn` retirado (#164); (c) **una migración
  que no es opcional** para obtener el efecto de #164 —regenerar y re-aplicar la security policy de
  cada tabla `grant: all`— con su advertencia de **aviso apagado**: hasta re-aplicar, el compilador
  reporta cero dependencias mientras la columna sigue atada en el motor; (d) la fase **`standby`** de
  0.20.0, que da «sano» a un nodo que no sirve si el chequeo juzga por `r.ok`; (e) que **su producción
  corre 0.18.0** —verificado por el frente arbol contra la VM viva—, o sea sin ninguna de estas
  correcciones. `reg 2026-08-18`

- **Las imágenes hasta 0.20.0 inclusive están MUDAS: no traen changelog ni labels** — el arreglo de
  #229 entró después de ese corte, así que solo desde **0.20.1** la imagen contesta «¿qué exige
  esto?» sin salir de la VM. Medido contra el registry: `:0.18.0`, `:0.19.0` y `:0.20.0` devuelven
  `documentation` ausente. **Muerde justo en el salto vivo del operador** (0.18.0 → 0.20.x): para
  ese tramo el **repo sigue siendo la fuente** y la imagen no ayuda. Se extingue solo cuando la
  instancia corra ≥0.20.1. `reg 2026-08-18`

- **Dos conjeturas del 0.15.0 SIGUEN sin verificar, y el deploy no las tocó** — de las cuatro que
  esperaban producción, el despliegue del 2026-08-11 saldó dos (#139·N2 siembra ✓, #151 reclasifica ✓)
  y **las otras dos no, porque no dependían del deploy sino de condiciones que PROD no tiene**:
  (a) **el eslabón `serve-rls → runSpec` con identidad del roster** (#145) — PROD no declara
  `MIRANDA_PREVIEW_IDENTITIES`, así que la preview impersonada contra motor vivo no se ejercitó;
  poblar el roster es decisión de instancia; (b) **la entrega HTTP real por un sink recargado**
  (#151) — el mecanismo está demostrado por test, pero la línea del fan-out en producción sigue
  siendo inspección, no medición. **Ninguna de las dos se vuelve verdadera por el hecho de que el
  deploy saliera bien.** `reg 2026-08-11`
- **`VERGIS_CSRF_SECRET` no definido en QA** — *actualizado 2026-08-10*: en **PROD ya está aplicado**
  (sesión de A.R.B.O.L. del 2026-08-10 tarde, KV `arbol-secrets/vergis-csrf-secret`, corte medido
  6.597 ms). En **QA sigue sin definir** — verificado hoy: `vergis.env` de QA no declara ninguno de
  `VERGIS_NOTIFY|PI_OWNERS|SOURCES|POLICIES` ni el CSRF. Consecuencia observable: `/contrato` reporta
  `watches: []` en QA, que **no es defecto** sino ausencia de archivos que vigilar.
  `reg 2026-08-06 · act 2026-08-10`
- **QA: 403 del service principal al observar 2 items del motor** (`ingest_finanzas_saldos`,
  `ingest_personas_asistencia`) — el lazo de frescura degrada como fue diseñado (registra y sigue),
  pero el entorno QA queda sin observabilidad real de esos procesos. Permisos del SP en el
  workspace de QA. No es regresión de 0.14.0. `reg 2026-08-06`

## Espera decisión de César

*(vacío — las decisiones del cluster 004 se resolvieron el 2026-08-08: 13 aprobadas, 1 diferida
a `TODO.md` (marca). Quedan diferidas POR DISEÑO con disparador propio, no esperando a César:
multi-tenancy (004/11 E5) y re-evaluación de licencia del kernel (004/11 E4).)*

## Código / CI

- **El extractor de fase del rollout se llama SIN el gate de status en el camino de diagnóstico** —
  `phase_of()` (`deploy/rollout/vergis-rollout:206`) saca la fase del cuerpo con un `sed`. El
  **veredicto** está protegido: `serving_ok` exige `200` antes de mirarla. El **`warn` del smoke**
  (`:402`) no: llama a `phase_of` sobre el cuerpo de un fallo, así que cualquier cuerpo de error que
  contenga el literal imprime una fase falsa **justo cuando alguien está diagnosticando**.
  **La ocurrencia concreta ya se cortó en la fuente** el 2026-08-26 —`deploy/edge/espera.html`, que es
  el cuerpo del 503 del borde, llevaba el literal en un comentario; medido con el extractor real y su
  control positivo—. Queda el **defecto de forma**: el lector sigue sin gate, así que el próximo
  cuerpo de error que traiga el literal reabre lo mismo. Cortar en la fuente fue lo correcto (los
  lectores se multiplican, la fuente es una), pero no es lo mismo que arreglar al lector.
  **No se tocó**, y la razón es de custodia, no de criterio: `deploy/rollout/` es del frente **arbol**
  y lo está editando ahora mismo. Avisado por mensaje directo el 2026-08-26. `reg 2026-08-26`

- ~~**El arnés de Fabric mide la discriminación con el principal EQUIVOCADO, y así se coló #238**~~ —
  todas las comprobaciones de discriminación corrían como `admin` (`fabric-lab-proof.ts:232-233` y
  `:346-347`); el único sondeo que usaba el service principal era P5. El admin **siempre** tiene
  `UNMASK`, así que los verdes que cerraron #197 midieron una propiedad real sobre un sujeto que no
  es el que sirve. **Lo que faltaba no era un test más, era un control de premisa**: verificar el
  estado del sujeto **en el plano de datos** —no en el de control, que miente durante la staleness de
  revocación— antes de creerle a cualquier veredicto sobre `UNMASK`. `reg 2026-08-19`
  **CERRADA 2026-08-19 (PR #244):** el arnés tiene sondeo P9, que mide la discriminación con el
  principal que **sirve** y no concluye sin premisa: el estado del sujeto se mide **leyendo** la tabla
  y, si contradice el `FAB_SP_ROLE` declarado, el sondeo **se niega a concluir**. Las comprobaciones
  del admin se conservan a propósito, rotuladas REFERENCIA — el contraste admin-vs-SP es lo que hizo
  visible #238. El arnés estrena además un tercer estado, `⚠ NO MEDIDO` (antes «no pude medir» salía
  como hallazgo, indistinguible de un dato), con código de salida propio (3).
  **Y un defecto nuevo que el cierre destapó:** el test por desigualdad de JSON que la ficha daba por
  bueno **no habría atrapado #238** — la rama `ELSE` de la vista devuelve el literal del IR (`•••`) y
  el DDM devuelve el default del tipo (`XXXX`), así que las dos lecturas difieren sin que ninguna
  traiga el dato. P9 juzga si el claim concede el **valor real** (los ruts sintéticos, conocidos por
  construcción), no si las lecturas difieren.
  **Verificado de FORMA, no contra el motor:** `typecheck` verde, el SQL emitido revisado a mano
  (sale del compilador, `FAB_PROOF_PRINT_SQL=1 npm run fab:sql`) y la lógica de la premisa ejercitada
  con dobles. **Queda sin medir** hasta la primera corrida con la ventana de capacidad abierta.

- **La staleness de revocación de rol supera los 20 min** — cota medida el 2026-08-19: rol bajado a
  `Viewer` a las 13:50:47 UTC, y a las 14:11:40 el SP seguía leyendo **en claro**. El experimento que
  la esperaba **se negó a concluir**, que es lo correcto. Sigue sin medirse el techo y qué la termina.
  **Consecuencia práctica inmediata**: cualquier medición sobre el SP de laboratorio queda inválida
  durante una ventana de al menos 20 min después de tocarle el rol, así que **el experimento se
  planifica antes de tocar el plano de control, no después**. `reg 2026-08-19`

- **El DDL del centinela de #238 se midió contra Fabric DESPUÉS de taggear 0.21.0, no antes** — el
  orden estuvo mal y el resultado no lo arregla. La medición salió limpia (las 3 sentencias
  aceptadas, idempotentes, descubrimiento y máscara corroborados en `sys`, control positivo del
  instrumento en verde), pero **eso se supo 20 min después de empujar el tag**. Si Fabric hubiera
  rechazado una sentencia, la versión publicada habría traído DDL inejecutable — exactamente el modo
  de falla de #197, que este mismo emisor ya pagó una vez. **La regla que faltaba aplicar no es
  nueva**: un mecanismo no se publica sin el experimento que lo pone en riesgo, y «publicar» empieza
  en el tag, no en el aviso. El arnés del terreno (`fab:proof`) debería incluir el centinela para que
  esto no dependa de que alguien se acuerde. `reg 2026-08-19`
  **CERRADA 2026-08-19 (PR #244):** el centinela es el sondeo **P10** de `fab:proof`, con lo que midió
  el experimento suelto —las 3 sentencias emitidas, idempotencia real (crear-si-falta, una sola fila
  tras dos pasadas), el descubrimiento del serving, la corroboración en `sys`, el control positivo del
  instrumento con el admin y el estado `uninstrumented` honesto— más dos cosas que el experimento no
  medía: el **retiro verificado midiendo** (no se supone que `dropSQL` funcionó porque no dio error) y
  que el SQL del **emisor** y el del **serving** sean el mismo byte a byte. Su cabecera declara que
  este sondeo es la condición de cortar versión cuando el corte toca el centinela.
  **Verificado de FORMA:** ver la ficha de arriba. **Queda sin medir** hasta la primera corrida con la
  ventana abierta.

- **La conexión viva es una frontera de autorización, y el nodo sostiene un pool** — medido el
  2026-08-19 contra Fabric: una conexión ya abierta **nunca** vio el cambio de rol dentro de la
  ventana de sondeo (60 s tras conceder), mientras conexiones nuevas lo vieron en ≤11 s. **La
  autorización se fija al conectar.** Importa para el Producto y no solo para el arnés: el nodo de
  serving sostiene conexiones reusadas, así que **revocarle un privilegio a un principal no surte
  efecto sobre las conexiones que ya tenía abiertas** — y sumado a la staleness de revocación del
  servicio, la ventana de privilegio residual es más larga que cualquiera de las dos por separado.
  **No medido contra el Producto**, solo contra el arnés: cuánto viven las conexiones de su pool y si
  las recicla es la pregunta que decide si esto muerde. `reg 2026-08-19`

- **Revocar un rol de workspace en Fabric NO toma efecto de inmediato, y no se sabe qué lo destraba**
  — medido el 2026-08-16: subir el SP de `Viewer` a `Member` cambió el resultado en la **primera**
  lectura (t+0s); bajarlo de `Member` a `Viewer` **no tomó efecto en 6,5 minutos de sondeo continuo**
  (14 lecturas, el principal siguió viendo el valor real). La máscara se observó recién **después de
  recrear tabla y política**, así que hay dos candidatos —el tiempo o la re-aplicación del DDL— y
  **cuál de los dos NO está medido**.
  **ACOTADO el 2026-08-19 con el experimento del rol** (sin tocar DDL, tres vías en paralelo):
  conceder propaga en **≤11 s** a una conexión nueva; **revocar NO propaga en >300 s**, y **ni una
  conexión nueva ni un token de acceso nuevo la destraban** — o sea que la hipótesis del token
  cacheado, que era el tercer candidato, queda **refutada**. Sigue sin medirse **cuánto dura** y
  **qué la termina**: entre una lectura contaminada y una limpia pasaron ~4 h y una pausa de
  capacidad, y cuál de las dos la cortó se desconoce. Ya cobró su primera víctima documentada — el
  veredicto falso de P5 esa misma mañana. Importa por dos vías: (a) es un asimetría de seguridad
  —conceder privilegio es instantáneo, quitarlo no—; (b) **envenenó una medición de esta misma
  sesión**: el primer veredicto sobre `UNMASK` fue el opuesto al correcto y se publicó como hallazgo
  antes de que tres corridas seguidas lo desmintieran. El experimento que falta es barato: bajar el
  rol y sondear con TTL largo **sin** tocar el DDL. `reg 2026-08-16`
- **Ningún registro del repo declaraba dos capacidades Fabric vivas en el tenant propio** — al
  levantar el terreno aparecieron, *Active* en Chile Central, una capacidad **Trial FTL64**
  (`Trial-20260525T022032Z-…`, iniciada el 2026-05-25) y una **PP3 «Premium Per User - Reserved»**,
  con los workspaces `arbol-lab-smoke-test` y `arbol-lab-qw04`. **No se tocaron** y quedaron
  declaradas en `RESOURCES.md`. Consumen presupuesto o licencia y **la decisión de qué hacer con
  ellas es de César** (gasto). Se anota acá porque el hallazgo es del agente, no encargo suyo.
  `reg 2026-08-16`
  **RE-DERIVADA 2026-08-26 — y lo importante es lo que NO se pudo medir.**
  Medido: la **suscripción** ultraBASE tiene hoy **un solo recurso ARM**, `vergisfablab` (F2,
  `westus2`). Sin filtro de tipo, sin nada en `chilecentral`, y cero capacidades
  `Microsoft.PowerBIDedicated`.
  **Eso NO cierra la ficha, y el porqué es el punto**: un **Trial** y una **PPU** no son recursos ARM
  —viven en el plano de Fabric— así que `az resource list` **no puede verlos**. Un vacío ahí significa
  *«no pude medir»*, no *«no existen»*. Tratarlo como cierre sería exactamente el instrumento que
  falla hacia el verde.
  **El instrumento que sí decide** es `GET https://api.fabric.microsoft.com/v1/capacities` contra el
  tenant ultraBASE, y **no se pudo correr**: la cuenta `az` activa en esta máquina es la **del
  cliente** (`arboltec@grupohijuelas.com`) y el tenant propio la rechaza —
  `AADSTS50020: … does not exist in tenant 'ultraBASE'`. Destrabarlo es **un login interactivo de
  César**, que es credencial y no gasto:
  `az login --tenant 41eb660f-56d9-407a-93e0-c1e5eb7be21c --scope "https://api.fabric.microsoft.com/.default"`.
  **Una inferencia, etiquetada como tal**: el Trial arrancó el 2026-05-25 y los trials de Fabric duran
  60 días, así que a hoy lleva **93** — probablemente ya murió. **Es inferencia de la documentación,
  no medición**, y no se escribe como cierre. `act 2026-08-26`
- **Una consulta de instancia sigue abierta, y ya no es sobre la severidad de #197 sino sobre
  `UNMASK`** (*act 2026-08-19: la pregunta ya NO es si el mecanismo existe —se midió en terreno propio,
  y con `Viewer` el SP de laboratorio lee en claro—, sino qué ocurre en la instancia del cliente*) —
  lo que queda: **¿con qué rol de workspace corre el service principal de serving de la instancia?** Decide si el cinturón DDM le muerde (`Viewer`) o si lee la
  tabla en claro (`Member`), y por lo tanto si la rama «en claro» de la vista sirve de algo. Es la
  misma pregunta que P5 por otra vía, y **es una consulta contra la instancia, no un frente**.
  Conserva valor la otra mitad, con otro sentido: **¿algún PI nombra una `vw_mask_*`?** — ya no mide
  el daño, mide **a quién le sirve el arreglo**. `reg 2026-08-16 · act 2026-08-18`

- **El frente de authz dejó cuatro cosas sin medir — quedan DOS, y ya no por falta de terreno**
  (*encogido el 2026-08-14 con el arnés T-SQL local; la premisa «ninguna se puede medir sin terreno
  vivo» resultó falsa para la mitad*):
  (a) **¿el SP de serving tiene `UNMASK`?** — **CORREGIDA el 2026-08-16 contra Fabric real: el
  mecanismo que esta ficha daba por medido NO OCURRE en Fabric.** La disyuntiva «sin `UNMASK` la
  rama en claro devuelve el default / con `UNMASK` la vista discrimina» describe la semántica
  T-SQL. **Corregido otra vez el 2026-08-18: la disyuntiva VUELVE a aplicar en Fabric**, porque
  #197 quedó resuelto y la vista ya se consulta y discrimina desde 0.19.0 — o sea que cuál de las dos
  ramas ocurre **depende ahora sí** de si el SP tiene `UNMASK`, y eso sigue **sin medirse**. Lo que
  quedó medido: **`UNMASK` lo decide el ROL del workspace** — `Member` lee el valor real, `Viewer`
  lee la máscara. Queda un dato de instancia, y sigue siendo **una consulta, no un frente**: con qué
  rol corre el SP de serving. Mientras no se mida, lo prudente es asumir la rama degradada. (b) **RESUELTA y peor de lo que se temía**: el `ADD MASKED` no entra sobre una tabla
  con vista-contrato — es **orden**, no incompatibilidad, y el motor lo rechazaba sin nombrar al
  culpable. Corregido con preflight diagnosticado; ver #163 y `DECISIONS.md` D-30. (c) el **costo de
  enforcement** por columna sigue abierto, pero **ya no por falta de terreno**: el terreno Fabric
  propio existe (#186, `npm run fab:proof`) y el costo es una medición pendiente, no un frente.
  (d) el bit `is_schema_bound` **quedó medido el 2026-08-16 contra Fabric por driver real**:
  `sys.security_policies` devolvió `is_schema_bound: true` —booleano, el caso que el código ya
  acepta—. Vale para **este driver (`mssql`) y este SKU**; otro driver sigue sin medir.
  `reg 2026-08-13 · act 2026-08-16`
- **Miranda deja de muestrear los objetos que NO estén en el policy store** — consecuencia del
  escudo de columna (#163·H9) y de su lectura estricta de «sin política ⇒ no se sondea». Es
  coherente con la doctrina del nodo (dato sin política no se sirve) y es fail-closed, **pero si el
  catálogo de Miranda de una instancia incluye tablas fuera del store, se nota de inmediato**: el
  `describe_table` nombra el esquema y devuelve muestra vacía. Reversible en una línea de
  `columnShield`. **No verificado contra el catálogo de la instancia de referencia.** `reg 2026-08-13`
- **Dos límites declarados del reconocimiento de la vista de máscara** — (a) si una instancia generó
  su DDL con `maskViewName` propio, la derivación por convención no la encuentra y el PI queda **no
  servible** (ruidoso, jamás en claro); la vía entonces es declararla en el store, no aflojar el
  reconocimiento. (b) la corroboración contra `sys` es una **foto del bootstrap**: un `ALTER VIEW`
  posterior no se detecta hasta el próximo `bootstrapAll`, y acá —a diferencia del linaje
  schemabound— nada ata la base. `reg 2026-08-13`
- **El veto de `run_probe` es por token, sin parser SQL** — sobre-bloquea: una columna protegida
  llamada `rut` veta probes que nombren el `rut` de OTRA tabla del `FROM`. Consciente y documentado;
  se anota porque el primer reporte de «Miranda no me deja consultar algo que sí puedo ver» va a
  venir de acá y conviene no diagnosticarlo desde cero. `reg 2026-08-13`
  **Veredicto (act 2026-08-26): ESTADO ACEPTADO, no pendiente.** Se sella para que el barrido de TTL
  no la archive como «vencida **sin** veredicto» — no le falta trabajo, le sobra archivo: su casa
  natural es `docs/`, y mudarla es decisión de César.

- **El render de gráficos: queda un residuo que ninguna capa detiene** — un exploit de Vega que haga
  E/S **sin pasar por su loader** (p. ej. vía una dependencia transitiva) atraviesa el gate
  declarativo y el loader que niega. Es justo lo que cubriría un subproceso, y el subproceso se
  descartó con medición (D-21): el permission model de Node 22 **no cubre la red**. El día que haya
  driver, la fs se cierra con el permission model y **la red se cierra en la red del contenedor**,
  no en Node. `reg 2026-08-13`

- **✅ RESUELTO PARCIAL, con la pérdida ACEPTADA y protegida (2026-08-13) — el control positivo en
  slots land-only.** La decisión de no correr el control **por-archivo** sin corridas **se ratificó**
  tras evaluar tres variantes de corte: todas fabrican alertas falsas o exigen un contrato externo
  nuevo. Lo que sí se agregó, porque no necesita corte: **control positivo sobre el DIRECTORIO** —
  `listOrAbsent` dice `absent` + ≥1 carga vivida ⇒ contradicción—, que cubre la lente rota tipo 404,
  o sea la ceguera exacta del incidente fundante. Commit `52272db`.
  **La pérdida residual —200-vacío sobre un directorio que sí existe, en land-only— queda ACEPTADA**,
  y protegida por un test cuyo nombre lo dice: *«CONTROL NEGATIVO QUE FIJA UNA DECISIÓN — land-only
  con 200-vacío sobre directorio EXISTENTE: NO contradice, y así debe quedar»*. Existe para que nadie
  la «arregle» sin volver a pensar el problema.
  **Gate de despliegue pendiente (C6)**: que drenar un landing real deje el directorio existente
  (`listOrAbsent` ⇒ `ok` vacío, no `absent`). Acotado desde el código —ningún camino de Vergis borra
  el directorio, solo hace `remove` del archivo—, pero la semántica de OneLake no se puede medir sin
  terreno. **Si un landing vaciado devuelve `absent`, este control se retira.** `reg 2026-08-13 · resuelto 2026-08-13`
- **Dos supuestos del frente #161/#162 sin verificar contra motor vivo** — (a) que un job que muere
  antes de arrancar aparezca como `Failed` en `jobs/instances`; (b) que la correlación carga↔corrida
  aguante el desfase de reloj del motor: **no lleva margen**, y con el reloj adelantado una corrida
  real podría quedar fuera y la carga terminaría marcada `varada`. Ambos son de la familia de los
  gates manuales del despliegue. `reg 2026-08-13`

- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`

## Práctica / entorno (fuera del árbol de Vergis)

- **`/ww:work` no consume `POLICIES.md`, y el Reglamento ya promete que sí** — al registrar el
  canónico se escribió en `ww:wingworking` que *«lo que cae bajo una política vigente deja de
  aparecer en el bloque Decisiones»*, y **ninguna skill implementa esa lectura**: verificado con
  `grep -rl POLICIES` sobre el plugin `ww`, el único archivo que lo nombra es el Reglamento mismo
  (más `ww:start`, que lo agrega a su Tier 2 de lectura). Hoy funciona en Vergis **por otra vía** —
  el `CLAUDE.md` del proyecto lo ancla y se inyecta en toda sesión—, así que la mitigación es local y
  la promesa es general: en un proyecto que declare `POLICIES.md` sin nombrarlo en su `CLAUDE.md`,
  la vista seguiría subiéndole al principal lo que él ya autorizó. **Es una afirmación del Reglamento
  que hoy no se cumple sola**, y se anota con esas palabras en vez de darla por hecha (Norma 6).
  Lo barato: que el Paso de enumeración de `/ww:work` lea `POLICIES.md` del proyecto y filtre.
  `reg 2026-08-18`
  **RE-DERIVADA 2026-08-26 contra la fuente viva — RANCIO PARCIAL: media ficha ya no es cierta.**
  `grep -rl POLICIES ~/.claude/skills/ww/` devuelve hoy **tres** archivos, no uno: el Reglamento,
  `ww:start` y —esto es lo nuevo— **`ww:deuda`**, cuyo Paso 4 declara que *«si `POLICIES.md` declara un
  presupuesto vigente, lo que cabe bajo su techo sí se decide y se ejecuta, y se asienta en el
  ledger»*. O sea que **el gate de decisión sí lee la política**; lo que sigue sin implementarse es la
  otra mitad, la que la ficha citaba: **la vista de `/ww:work` no filtra el bloque Decisiones por
  política vigente** — `ww:work/SKILL.md` no nombra `POLICIES.md` ni una vez.
  **Por qué no se arregló hoy pese al mandato de saldar:** el sujeto vive en el repo `protocolos`, y al
  mirarlo antes de tocarlo aparecieron los dos reconocedores de **W-01** a la vez — tres commits del
  día que esta sesión no hizo (programa `sov`) y un archivo sin commitear ajeno. Registrado como
  **ocurrencia 39** en `~/.claude/WATCH-logs.md`, sin colisión material porque se vio antes de escribir.
  **Queda como hand-off con su forma dicha**: una enmienda al Paso de enumeración de `ww:work`,
  propuesta **por PR y sin self-merge** —la pluma del Reglamento es de César, como el PR #2 pendiente
  de `wingcoding`—, y **coordinada con el frente que está escribiendo `protocolos`**.
  `act 2026-08-26`

