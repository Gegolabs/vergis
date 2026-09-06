# DECISIONS — decisiones tomadas en nombre de César (modo autónomo)

Registro exigido por la skill `procesamiento-autonomo`. Toda entrada es **revocable**:
el registro existe para que revertirla sea barato.

| Campo | Contenido |
|---|---|
| Sesión | 2026-08-06 · atención de los requests abiertos (work/002) · 2026-08-07 · solicitudes #138/#139 (work/003) · 2026-08-08 · ejecución de atendibles (work/005) · 2026-08-08 · fase 2 de #107 (work/006) · 2026-08-10 · trabajo del pasivo (`/ww:work run`) · 2026-08-14 · atención de #178 y corte de 0.16.0 · 2026-08-14 (noche) · arnés T-SQL local y corrección del plano de columna de #163 · 2026-08-16 · terreno Fabric propio (#186) y medición del plano de columna · 2026-08-17 · atención autónoma del pasivo externo (`/ww:work run external`) · 2026-08-18 · ventana de capacidad Fabric: P6 (#197) y P7 (#164) medidos · 2026-08-18 (tarde) · retome `/ww:go`: #197 y #164 implementados, medidos con el SQL emitido, mergeados y cerrados · 2026-08-19 · P5 medido, experimento del rol, y la implementación de #238 (diseño de Fable, ratificado por César) · 2026-08-26 · saldado autónomo del pasivo: los controles que no controlaban (`/ww:work run`) · 2026-09-02 · custodia por mandato: cerrar todos los issues de producto y publicar (César: «asume el rol del mantenedor… cierra todos los issues de producto y déjalos publicados») |

---

## D-78 · 2026-09-06 — H1 del plan de escala se mergea con CI verde (#298) y sus números ordenan H2–H7: el techo de Daftar lo pone el store en disco y el catálogo, no el runtime

- **Bifurcación**: (a) dejar #298 abierto para que César lo mire · (b) mergear con sombrero de custodio (mandato vigente desde D-59), CI verde y controles negativos en rojo antes de las series.
- **Decidido**: **(b)**. CN-B 28.000 `SINMEDIR:rechazo` / 0 OK / 0 MAL; CN-A 8.058 escrituras 100 % `409-standby`. Series sin MAL ni SINMEDIR y cero pérdidas: Daftar S₀ techo **50 VU** (POST p95 134,8 ms, `r_post` ≈ 248/s) · S₀′ con 5.200 guías **25 VU** · S₁ con 5.000 intentos (3,92 MB) **10 VU** · Mira contra ClickHouse **≥ 200 VU sin techo** (p95 241 ms, ~1.000 rps, `t_render/t_motor` ≤ 2,2 por resta con `system.query_log`). **Lo que cambia del plan 06:** (1) el costo del `POST` crece con el tamaño del store en dirección corroborada (×2, techo ÷2,5) — lineal sigue siendo conjetura; (2) el consumidor de CPU dominante en lectura es `listar()` del catálogo (3,3 → 23,3 ms de 200 a 5.200 guías), que no estaba en ningún hito; (3) con `VERGIS_OUT` en bind-mount de macOS el guard de escritura se dispara por cambio de inodo y degrada el nodo de forma terminal con `/healthz` en `serving` → **issue #299**. No medido: Mira contra stub, la forma de `r_post(S)`, Mira con N identidades.
- **Costo de revertir**: `git revert` del merge; el arnés no toca el runtime.

## D-77 · 2026-09-06 — Los cinco PRs de Renovate (#261, #260, #251, #201, #175) NO se mergean hoy: `renovate/stability-days` sigue `PENDING` en los cinco

- **Bifurcación**: (a) mergearlos con CI verde (`test`, `shell`, `review` en SUCCESS) · (b) respetar la regla del NEXT («los que tengan `stability-days` en `pass`») y no mergear ninguno.
- **Decidido**: **(b)**. El check `renovate/stability-days` está `PENDING` en los cinco (medido con `gh pr view --json statusCheckRollup`, 2026-09-06 02:10Z; el más viejo, #175, lleva semanas así). Un `PENDING` que no cambia en semanas huele a status que Renovate dejó de refrescar más que a una edad mínima real, pero **no está medido**: la config de `minimumReleaseAge` y el último run de Renovate no se revisaron. Mergear por encima del check es decidir en nombre de la política de dependencias, y esa la fijó César al configurar Renovate.
- **Costo de revertir**: nulo — mergear después es un clic; queda como hand-off: revisar la config de Renovate (`renovate.json`) y por qué el status no avanza.

## D-76 · 2026-09-06 — El directorio `undefined/` sin trackear en la raíz se borra; su causa queda como conjetura

- **Bifurcación**: (a) conservarlo hasta identificar el script que lo escribió · (b) borrarlo, dejando la causa declarada como conjetura.
- **Decidido**: **(b)**. Contenido: `undefined/pi02-render/` (5 HTML de PI-02: pnl-consolidado, pnl-empresa, detalle-*) y `undefined/pi02-render.log.jsonl` (`botler-start`, `agencyDomain: vergis-lab`), todo del **2026-09-03 17:48Z**, la hora exacta de la realización de PI-02 sobre la v11 en el lab. Es un render local de QA ya consumido (PI-02 pasó a QA ese día con sus artefactos en el lab). **Causa conjeturada, no verificada:** un template literal `${dir}/pi02-render` con `dir` indefinido en el arnés que invocó el CLI —`undefined/` es firma de JavaScript, no de shell (una variable de shell vacía habría dado `/pi02-render`)—; el CLI mismo no lo produce (`packages/cli/src/main.ts:23` cae a `process.cwd()` sin `--out`). No se encontró el invocador en `lab/scripts`. Refutador: volver a correr el render de PI-02 con el arnés del 3-sep y ver si reaparece.
- **Costo de revertir**: nulo — eran artefactos regenerables.

## D-72 · 2026-09-05 — La puerta de salida genérica del Botler es `ProtoBotlet.invoke` con un binding server-side por proto, no la clase `Botler` de `packages/botler`

- **Bifurcación**: (a) instanciar la clase `Botler` (register/invoke/capabilityCall) en el servidor y pasar Mira y Daftar por ella · (b) extender `ProtoBotlet` con `invoke(spec, specPath, LetInvocation) → LetResponse | null` y que cada proto reciba en su construcción lo que necesita del nodo (Mira: `render`; Daftar: store, directorio de instrumentos) · (c) rutas registradas por proto en el router.
- **Decidido**: **(b)**. La clase `Botler` es el runtime de `runSpec` (CLI) y su `invoke` es por Botlet-instancia con capabilities; el servidor hoy no la usa y forzarla exigiría reescribir `runPi` y su clausura entera para un beneficio que no cambia la conducta. (b) deja UNA frontera (la `LetInvocation`) que el router no entiende y que sirve a las dos familias; (c) habría metido conocimiento de dominio en el router. La clase `Botler` queda para cuando el nodo hospede Lets con capabilities propias (el Agentlet), y se dice en el brief.
- **Costo de revertir**: medio — la frontera `LetInvocation` sobreviviría a (a).

## D-73 · 2026-09-05 — Un proto declara si consume datos gobernados (`consumesData`); si no, el descubrimiento no le exige capabilities ni tablas y su autorización es suya

- **Bifurcación**: (a) exigir que Daftar declare una capability ficticia para pasar el filtro `caps.length === 0 → omitido` · (b) un flag en la interfaz que el descubrimiento respeta · (c) relajar el filtro para todos.
- **Decidido**: **(b)**. (a) es mentirle al catálogo de serving; (c) abriría la puerta a una spec de Mira sin datos servida como PI vacío, que hoy está deliberadamente omitida. Consecuencias aceptadas: un Let sin datos es visible para toda identidad en el índice (no hay tabla que lo gobierne) y decide adentro quién entra; en fabric no entra a la verificación por PI y cuenta como `serving` en `lets`.
- **Costo de revertir**: bajo.

## D-74 · 2026-09-05 — El gate de H3 mide un nodo (más un standby por lease) y deja la promoción de dos anillos con intento a medias para H5

- **Bifurcación**: el diseño rector pone en H3 «e2e local con dos anillos: promoción sin corte con un intento a medias». (a) construir un banco de anillos para Daftar (compose propio, poller, mutador que POSTea progreso) dentro de H3 · (b) medir en H3 lo que un nodo y un standby ya permiten (409 nombrando al activo, publicación en caliente) y medir la promoción en H5, cuando exista la instancia con su compose derivado de `compose.reference`.
- **Decidido**: **(b)**. El banco actual es de Mira (ClickHouse sembrado, mutador de impresiones); duplicarlo para Daftar en H3 dobla el hito sin cambiar el mecanismo bajo prueba, que es el mismo plano de control ya medido con V-14. Lo que sí es nuevo —que un POST de progreso respete el 409— se mide con el standby real. La promoción con intento a medias se declara **sin medir** en el CHANGELOG hasta H5.
- **Costo de revertir**: nulo — H5 puede reusar el banco con un mutador de progreso.

## D-75 · 2026-09-05 — Instrumentos y reportes de Daftar son archivos releídos en caliente; el store `evaluaciones` guarda intentos y revisiones, y registra instrumentos solo como espejo idempotente

- **Bifurcación**: (a) instrumentos en el store (publicar = INSERT por API) · (b) instrumentos como archivos en `VERGIS_INSTRUMENTOS_DIR`, como las specs de Mira en `VERGIS_SPECS_DIR`, con el store como espejo por sha · (c) los reportes también en el store.
- **Decidido**: **(b)**, y los reportes como archivos. Es la regla B3 del diseño rector («publicar un instrumento es copiar un archivo») y la mecánica que la instancia ya sabe operar; la inmutabilidad se hace cumplir por aviso (sha distinto con el mismo id se loguea una vez) y no por rechazo, porque un rechazo dejaría a un estudiante sin la guía corregida a mano en el disco. (c) habría exigido una API de escritura para un artefacto que producimos fuera del nodo.
- **Costo de revertir**: bajo — el store ya tiene las tablas.

## D-71 · 2026-09-05 — Con H0–H2 mergeados NO se corta versión todavía: 0.27.0 se corta cuando aterrice H3, que es lo que le da sentido al «rompe»

- **Bifurcación**: (a) cortar 0.27.0 ahora con H0 (refactor sin conducta nueva), H1 («rompe»: `pis → lets`, `botler-rollout`) y H2 (store que nadie consume) · (b) esperar a H3 (`packages/daftar`, el segundo proto-Botlet) y cortar una versión cuya capacidad justifique adoptar la ruptura.
- **Decidido**: **(b)**. Para la única instancia real (A.R.B.O.L.) 0.27.0 hoy sería una versión que solo exige trabajo (actualizar herramienta, healthcheck y poller) sin darle nada a cambio; el CHANGELOG ya declara el «rompe» bajo «Sin publicar» y la instancia no tiene demandante para adoptarlo. Además el corte exige la ventana de Fabric (`fab:proof`, POL-01) y su cadencia declarada es «antes del tag»: gastarla dos veces en una semana por dos cortes seguidos es peor que una. **Riesgo dicho:** «Sin publicar» acumula tres entradas; si otro frente necesita cortar antes de H3, corta con lo que hay — las entradas están completas.
- **Costo de revertir**: nulo — el corte es un acto de minutos con los cotejos al pie.

## D-70 · 2026-09-05 — H2 arranca en paralelo con H0 desde `main`, aunque el plan lo pone «después de H0»

- **Bifurcación**: (a) esperar el merge de H0 (gate con banco de anillos, decenas de minutos) antes de lanzar H2 · (b) lanzar H2 ya, desde `main`, con rebase obligatorio antes del PR.
- **Decidido**: **(b)**. La dependencia de H2 sobre H0 en el plan es conceptual (el store sirve a un proto que aún no existe), no de archivos: H0 toca `discovery.ts`, `packages/botler` y la construcción de `createDiscovery` en `serve-rls.ts`; H2 toca `packages/capabilities`, el `Dockerfile` y dos regiones distintas de `serve-rls.ts` (apertura de stores y `embeddedStores()`). El riesgo es un conflicto de rebase trivial; el beneficio es una hora de reloj. H1 sí espera a H0: comparte el healthz y el contrato con lo que H0 re-cablea.
- **Costo de revertir**: nulo.

## D-67 · 2026-09-05 — Los hitos H0–H2 del Botler genérico se anclan en issues propios (#289, #290, #291) abiertos desde la cuenta `cobach`, que además cumplen el aviso previo al frente arbol

- **Bifurcación**: (a) PRs sin issue, citando solo el doc 013 · (b) un issue por hito, que sirve de ancla `Closes #N`, de aviso previo al otro frente (CLAUDE.md §La custodia) y de registro público del alcance · (c) un solo issue paraguas para los siete hitos.
- **Decidido**: **(b)**. El aviso previo es norma del repo y el canal pactado ha sido el comentario/issue en GitHub (precedente: #232, 2026-08-26); un issue por hito deja el gate de cada uno verificable por separado, que es lo que la custodia necesita para mergear en orden. Se abrieron con la cuenta `cobach` porque es la única que `gh` tiene en esta máquina — la cuenta de bot sigue pendiente de César (PASIVO) y la autoría del agente va declarada al pie de cada issue.
- **Costo de revertir**: nulo — cerrar los issues con nota; los PRs sobreviven.

## D-68 · 2026-09-05 — H0 vuelve genérico el DESCUBRIMIENTO, no la invocación: `ProtoBotlet` nace sin `invoke`

- **Bifurcación**: el diseño rector nombra `invoke → output; routes?` en la interfaz de H0. (a) implementarlos ya, con Mira como único caso · (b) dejarlos para H3, cuando exista un segundo proto que invocar.
- **Decidido**: **(b)**. Con un solo caso, `invoke` sería `runPi` con otro nombre y su forma quedaría dictada por Mira — justo lo que un Botler genérico no debe hacer. El router ya es genérico por inyección (`renderReport`), así que no hay conducta que H0 pierda por esperar. H3 lo diseña con Daftar delante.
- **Costo de revertir**: bajo — es agregar métodos a una interfaz que ya existe.

## D-69 · 2026-09-05 — Una spec sin clave discriminadora se atribuye al único proto registrado, con aviso en el log; con dos o más protos se omite

- **Bifurcación**: hoy `discovery.ts` sirve cualquier YAML que parsee aunque no traiga `mira_version`. (a) exigir el discriminador desde H0 (rompería specs de instancia que no se pueden medir desde acá) · (b) atribuir al único proto y avisar · (c) atribuir siempre a Mira como default permanente.
- **Decidido**: **(b)**. Es la única regla que garantiza «cero cambio de conducta» para A.R.B.O.L. y a la vez escribe el camino de salida: el día que se registre Daftar, la spec sin discriminador deja de servirse y el log ya lo venía diciendo. (c) congelaría a Mira como privilegiada dentro del Botler.
- **Costo de revertir**: una función y dos tests.

## D-65 · 2026-09-03 — #279 se cierra con su ítem 1 construido; los ítems 2 y 3 quedan declarados fuera de alcance, sin issue nuevo

- **Bifurcación**: (a) construir los tres ítems del issue · (b) construir el 1 y abrir issues para el 2 (filas producidas por corrida) y el 3 (hora local del schedule) · (c) construir el 1 y declarar 2 y 3 fuera de alcance en el cierre.
- **Decidido**: **(c)**. El ítem 1 es el mecanismo que produjo el daño medido (nueve corridas sobre nada) y el único con demandante en la instancia. El 2 no se puede construir con honestidad desde el Producto: el historial de corridas de Fabric no expone filas producidas, y un conteo fabricado desde el destino sería otra promesa optimista. El 3 pierde su demandante con el 1: los slots manuales ya no reciben schedule, y las fuentes que el motor tira (SAP HANA) fijan su hora por su propio pipeline, no por el clic.
- **Alternativa descartada**: (b) porque abrir issues sin demandante es pasivo que nadie va a cobrar; si un steward vuelve a pedirlo, el issue se abre con su caso.
- **Costo de revertir**: nulo — se reabre #279 o se abre el issue con la cita.
<!-- segundo-ojo · Incorrecta (ítem 3): cronBody fija startDateTime=now también para procesos del motor · 2026-09-05 · juez Fable 5.1 · sha12 ad48a34e4658 · soveria-ai/audits/veredictos-20260905/ -->

## D-66 · 2026-09-03 — #285 y #286 se construyen como convención de plataforma decidida por el dato, sin vocabulario nuevo en el DSL, y la cascada de facetas es simétrica

- **Bifurcación**: orden de la faceta (a) por detección del tipo del conjunto de valores (numérico · fecha ISO · prefijo+número · nombres de mes · texto) · (b) por orden de primera aparición en las filas · (c) declarable en el spec (`filter: { order: … }`). Cascada (d) simétrica estilo autofiltro de Excel · (e) jerárquica declarada (`narrows:`).
- **Decidido**: **(a) + (d)**. (a) porque es el mismo patrón con que 0.24.0 y 0.25.0 eligen el popover (`vtIsNumericCol`, `vtIsDateCol`): lo decide el dato, aplica a todos los PIs sin ronda de spec, y no degrada las columnas de nombres (que (b) sí degradaría cuando la columna no es la primera llave de orden). (d) porque es el modelo mental del usuario que viene de Excel y no exige que el especificador declare jerarquías; la jerárquica sigue siendo el diseño de `narrows:` para los controles de la bandeja (TX-15 b), que no se toca.
- **Lo que esto NO garantiza, dicho**: la detección de nombres de mes es una tabla es/en; un PI con meses en otro idioma cae al orden alfabético. Al especificador de PI-30 se le dejó visible la bifurcación simétrica/jerárquica (comentario `11364` de la instancia).
- **Costo de revertir**: bajo — funciones puras con tests; (c) puede agregarse encima sin deshacer (a).
<!-- segundo-ojo · Correcta con salvedad medible: anclas TX-15 b y comentario 11364 no resuelven · 2026-09-05 · juez Fable 5.1 · sha12 101e51152f6f · soveria-ai/audits/veredictos-20260905/ -->

## D-64 · 2026-09-02 — El catálogo `CAP-NN` (#264) vive en `docs/capacidades.md` con cotejo mecánico parcial, sin gate de CI sobre el CHANGELOG

- **Bifurcación**: (a) wiki · (b) archivo del repo barrido a mano · (c) archivo del repo con gate de CI «PR que toca CHANGELOG toca el catálogo».
- **Decidido**: **(b) + un cotejo derivado del schema** (`scripts/capacidades-cotejo.ts`, corrido como test): IDs únicos y sin reuso, y **cada tipo de pieza / formato / clave de `interactions` del schema tiene fila**. El gate sobre el CHANGELOG **no** se automatiza: distinguir «capacidad nueva» de «corrección» en un `###` es heurístico y fallaría en silencio en los dos sentidos. En su lugar, el corte de versión exige el cotejo en verde y la regla queda escrita en «Antes de cortar».
- **Alternativa descartada**: (a) por lo que el issue ya argumenta (caché sin invalidación); (c) por frágil.
- **Lo que esto NO garantiza, dicho**: el catálogo puede omitir capacidades que no están en el schema (rutas HTTP, gobierno, plano de control): esas se barrieron a mano y pueden faltar.
- **Costo de revertir**: nulo — docs y un test.
<!-- segundo-ojo · Correcta: catálogo, cotejo verde como test en CI; refutador (ID duplicado) cae · 2026-09-05 · juez Fable 5.1 · sha12 ad477b61ca7f · soveria-ai/audits/veredictos-20260905/ -->

## D-63 · 2026-09-02 — #262 se construye entero: las cuatro piezas, no solo el aviso en pantalla

- **Bifurcación**: el issue pide cuatro piezas en orden de valor (resultado en pantalla · un target fallido no frena a los demás · «autoría N · réplica M» · republicación manual). ¿Se entrega la primera y se abre el resto, o entero?
- **Decidido**: **entero.** La pieza 1 sin la 4 deja al operador viendo el fallo sin poder reintentar (hoy tiene que editar una fila al azar), y la 3 es lo único que habría detectado el desfase de 11 días sin conocimiento de dominio. Sin la 2, un consumidor nuevo hereda los fallos del primero.
- **Regla que se le impuso al realizador**: un conteo de réplica que no se pudo leer dice «no se pudo leer», **jamás** 0 ni un número inventado — es la misma disciplina de «sin medir ≠ negativo».
- **Lo que queda fuera**: `VERGIS_MASTER_DATA` fuera del hot-reload (hallazgo vecino del issue) — no se toca en este hito; si merece issue, se abre aparte.
- **Costo de revertir**: revertir el PR.
<!-- segundo-ojo · Correcta con salvedad medible: Publisher.count() jamás corrió contra un motor · 2026-09-05 · juez Fable 5.1 · sha12 88ca4e6297eb · soveria-ai/audits/veredictos-20260905/ -->

## D-62 · 2026-09-02 — Fatal vs degradable se vuelve explícito en la config (#266), y #265 va en el mismo PR

- **Bifurcación**: (a) `try/catch` alrededor de `configFromEnv` que apague Miranda al fallar · (b) que `mirandaConfig` no lance y devuelva `enabled:false` con `disabledReason`, y que la config declare cuáles envs son fatales y cuáles degradables.
- **Decidido**: **(b).** (a) arregla el síntoma y deja la distinción implícita en el orden de validación, que es exactamente lo que el issue nombra como defecto. La propiedad es «el núcleo no cae por una superficie opcional», y se cumple haciéndola legible: `disabledReason` viaja al log de arranque, a `/contrato` y a la ruta de Miranda (503 con causa, solo para el grupo).
- **#265 en el mismo PR** porque es la misma función (`mirandaConfig`) y la misma regla: un `MIRANDA_API_BASE_URL` inválido también **degrada**, no aborta.
- **Lo que NO se mide antes de publicar**: el arranque de la imagen real con el flag encendido y sin key (lo corrobora el despliegue de la instancia, y así se declara en el CHANGELOG), y ningún gateway real (Foundry llega en 1-2 semanas).
- **Costo de revertir**: revertir el PR.
<!-- segundo-ojo · Correcta con salvedad medible: #275 solo config; arranque tumbó hasta 0.23.1 · 2026-09-05 · juez Fable 5.1 · sha12 90c178858198 · soveria-ai/audits/veredictos-20260905/ -->

## D-61 · 2026-09-02 — #186 se cierra: sus dos criterios abiertos están cumplidos u obsoletos

- **Bifurcación**: dejarlo abierto hasta «barrer `PENDINGS.md`» o cerrarlo.
- **Decidido**: **cerrar.** La medición de #164 en Fabric se corrió el 2026-08-19 (P7/P8, #236). `PENDINGS.md` ya no existe (D-57, pase a finish-v2): el criterio protegía que ninguna medición quedara trabada por falta de terreno, y eso está cumplido — el terreno contestó las cinco preguntas que solo Fabric contesta.
- **Costo de revertir**: reabrir.
<!-- segundo-ojo · Correcta con salvedad medible: P7/P8 son del 08-18; #236 es P5 · 2026-09-05 · juez Fable 5.1 · sha12 56f33cbfdf7e · soveria-ai/audits/veredictos-20260905/ -->

## D-60 · 2026-09-02 — #232 se cierra sin perseguir la propiedad completa (el intent NO entra en `acquire()`)

- **Bifurcación**: la que el custodio dejó escrita el 2026-08-26 para César: meter el intent dentro de `acquire()`, o decidir que no.
- **Decidido**: **no.** El intent es un archivo del volumen de gobierno que escribe una herramienta externa; darle autoridad sobre quién controla mueve la frontera de confianza fuera del plano de control. Lo entregado (#257, V-14: 0 fuera de predicado con control CN-2) cubre la promoción **orquestada**, que es la única forma en que hay un sucesor que nombrar.
- **Condición de reapertura, escrita en el issue**: un caso medido en que un release no orquestado produzca un ganador equivocado con impacto observable.
- **Costo de revertir**: reabrir; el código no cambia.
<!-- segundo-ojo · Correcta — acquire/#attempt sin intent; condición de reapertura escrita · 2026-09-05 · juez Fable 5.1 · sha12 849963f7051e · soveria-ai/audits/veredictos-20260905/ -->

## D-59 · 2026-09-02 — #250: salida (A), aviso en la nav conservando el 200

- **Bifurcación**: (A) aviso en la nav con 200 · (B) 404 · (C) dejar como está. El custodio la había dejado a César por ser elemento visible nuevo y diseño abierto; con el mandato de custodia, la decide esta casa.
- **Decidido**: **(A).** No rompe marcadores tras renombrar vistas (caso real) y le dice a la persona lo único que hoy no sabe: que su enlace estaba roto. Cuesta un `<p>` y un campo; la pestaña activa ya se marca. (B) convierte un typo en pantalla de error; (C) deja el daño intacto.
- **Elemento visible nuevo**: se verifica con captura antes del merge (Norma 8).
- **Costo de revertir**: revertir el PR.
<!-- segundo-ojo · Correcta con salvedad medible: la captura prometida no está en PR ni repo · 2026-09-05 · juez Fable 5.1 · sha12 5ca6f62d7900 · soveria-ai/audits/veredictos-20260905/ -->

## D-58 · 2026-08-26 — Las facetas client-side de #209 NO se implementan: se MIDE y nace issue

- **Bifurcación**: la ficha dejó abierta la pregunta de si el roce de #209 aparece también en las facetas client-side. Con el mandato de saldar, ¿se implementa el tope+buscador allá, o se mide y se levanta?
- **Decidido**: **medir y levantar issue** (#255). Y no por prudencia genérica: la medición destapó una **pregunta de diseño viva** que hace que copiar la solución sea incorrecto. El tope de #209 es CSS-only precisamente para que sin JS ninguna opción quede inalcanzable; las facetas client-side **no existen sin JS**, así que el argumento que forzó esa forma no aplica. Implementar «lo mismo» habría arrastrado una restricción que esta superficie no tiene.
- **Alternativa descartada**: implementar el tope+buscador acá mismo. Se descartó por lo anterior y porque **no se midió cuántos PIs vivos tienen una faceta de más de 12 opciones** — el dato que decide si esto vale hoy, y que es de instancia.
- **Lo medido, con control positivo**: mismo catálogo de 47 opciones por el mismo `renderHtmlPiece`; la superficie client-side materializa las 47 sin tope ni buscador, la server-side trae los dos. Sin el control positivo la sonda no habría probado que sabe verlos.
- **Costo de revertir**: nulo — es un issue.
<!-- segundo-ojo · Correcta — #255 con control positivo; #269 contestó la pregunta después · 2026-09-05 · juez Fable 5.1 · sha12 412082d97efc · soveria-ai/audits/veredictos-20260905/ -->

## D-57 · 2026-08-26 — La cadencia del arnés de Fabric es EL CORTE DE VERSIÓN, y se declara en dos sitios

- **Bifurcación**: el arnés de Fabric no puede tener gate (capacidad, credenciales, plata). ¿Se le declara una cadencia por calendario (semanal/mensual) o se le ata a un evento del proyecto?
- **Decidido**: **al evento — el corte de versión, antes de empujar el tag.** Una cadencia por calendario mide cuando no ha pasado nada y no mide cuando sí; atarla al corte la pone exactamente donde su resultado cambia una decisión (qué declara la versión que se publica).
- **Alternativa descartada**: cadencia por calendario con recordatorio. Se descartó porque depende de que alguien la mire, que es el defecto que la ficha nombra.
- **Dónde se declara, y por qué en dos**: en `scripts/README-fabric-lab.md` (donde vive el arnés) y en `CHANGELOG.md` §«Antes de cortar» (donde se lee **al cortar**). Una regla escrita solo en la casa del mecanismo no la lee quien ejecuta el evento.
- **El precedente que la fija**: el centinela de #238 se midió **20 min después** de empujar `v0.21.0`. Salió bien, y eso es lo que lo vuelve mal precedente.
- **Costo de revertir**: nulo — es documentación.
<!-- segundo-ojo · Correcta con salvedad medible: ventana ~2 min tras el tag, no veinte · 2026-09-05 · juez Fable 5.1 · sha12 4af12f6341fe · soveria-ai/audits/veredictos-20260905/ -->

## D-56 · 2026-08-26 — El arnés T-SQL entra al CI como WORKFLOW PROPIO con filtro de `paths`, no como job de `build.yml`

- **Bifurcación**: la ficha proponía «job propio, opcional, disparado por cambios en `packages/policy/**`». En GitHub Actions el filtro de `paths` es **por workflow, no por job**: dentro de `build.yml` la cadencia habría que emularla con un `if` sobre un paso que compara archivos.
- **Decidido**: **workflow propio** (`.github/workflows/tsql-lab.yml`). La cadencia *es* el punto de esta partida —un arnés que corre siempre no se distingue de uno que no corre nunca, en costo—, así que el filtro tiene que ser nativo y no una emulación que se rompe en silencio.
- **Y se resolvió la incógnita que la ficha declaraba «no medida»** —si el runner aguanta la imagen de SQL Server dentro del presupuesto—: **sí, y sobra**. Job completo en **31 s**, pull de la imagen **14 s**, motor aceptando conexiones al primer sondeo, `lab:proof` sin fallos y 6 hallazgos. Medido en la corrida `32970287379`, disparada por el propio push que agregó el workflow.
- **Decisión menor dentro de ésta**: el motor **no** lleva `--health-cmd` del servicio. La imagen 2022 dejó de traer `sqlcmd`, así que el health check idiomático mediría la ausencia de una herramienta y no la salud del motor. Se sondea el puerto, con cota de 180 s y salida **en rojo** que dice «NO SE PUDO MEDIR».
- **Costo de revertir**: nulo — borrar el archivo.
<!-- segundo-ojo · Correcta — 31 s, 14 s, sondeo al primer intento, 6 hallazgos re-medidos · 2026-09-05 · juez Fable 5.1 · sha12 dbe010aa16d1 · soveria-ai/audits/veredictos-20260905/ -->

## D-55 · 2026-08-26 — `notas-smoke` se arregla con un handle de INSPECCIÓN, no cerrando el store antes

- **Bifurcación**: el smoke moría al cerrar. Abría un segundo store de **escritura** sobre el mismo archivo para verificar la persistencia, su `close()` volcaba, y el fencing del primer handle abortaba el volcado. Dos salidas: cerrar el store original antes de reabrir, o abrir el segundo en `mode: 'read'`.
- **Decidido**: **`mode: 'read'`.** Cerrar el primero antes habría hecho pasar el test **cambiando lo que mide**: el paso 9 verifica que el archivo en disco tenga el dato **mientras el nodo sigue vivo**, que es la condición real. Y sobre todo: el fencing **tenía razón** — dos handles de escritura del mismo archivo son dos escritores, exactamente lo que existe para impedir. El defecto era del instrumento.
- **Alternativa descartada**: desarmar el fencing en el smoke (`fencing: false`). Habría apagado el único control que delató el problema.
- **Verificado**: 37/37 con el arreglo; y el crash reproducido contra la versión de `main` **antes** de tocar nada, para no atribuirme un fallo ajeno.
- **Costo de revertir**: nulo.
<!-- segundo-ojo · Correcta — crash reproducido antes del arreglo; 37/37 después · 2026-09-05 · juez Fable 5.1 · sha12 25ed7c8bb8e8 · soveria-ai/audits/veredictos-20260905/ -->

## D-54 · 2026-08-26 — `scripts/` entra al `include` del `tsconfig`, aunque destape errores

- **Bifurcación**: la ficha dejaba el hueco abierto a propósito —«tocar el `include` afecta a los demás scripts y puede destapar errores preexistentes»—. ¿Se mete el directorio entero, o se typechequean aparte con un tsconfig propio para no arriesgar el gate?
- **Decidido**: **entra al `include` del gate real.** Un segundo tsconfig sería otro instrumento que hay que acordarse de correr, que es la misma enfermedad un piso más abajo. Y el riesgo era acotable midiéndolo en vez de estimándolo: **cuatro errores, todos en un solo archivo**.
- **Lo que destapó, y justifica la decisión sola**: además de los cuatro errores de tipo, `scripts/notas-smoke.ts` **moría al correr** (ver D-55) y `admin-smoke.ts` reportaba la falta de su env con un stack crudo de `node:fs`. El gate ciego no decía «no medí»: decía «verde».
- **Control negativo corrido**: el mismo error deliberado en un script es **rojo** con `scripts/**/*` en el include y **verde** sin él. Lo que cambió no es que los scripts estén correctos — es que ahora se miran.
- **Costo de revertir**: nulo — quitar una línea del `include`.
<!-- segundo-ojo · Correcta — 4 errores en un archivo y control negativo re-medidos · 2026-09-05 · juez Fable 5.1 · sha12 21a7ebb855b8 · soveria-ai/audits/veredictos-20260905/ -->

## D-53 · 2026-08-19 — Se emprende #235 (`defaultField`) en modo autónomo, con #246 como prerrequisito

- **Bifurcación**: #235 pide una capacidad **nueva del DSL** —que el dato designe la opción por defecto de un control—, o sea contrato público que consumen los especificadores de la instancia. ¿Se implementa sin consultar, o sube a decisión por ser cambio de contrato?
- **Decidido**: **se implementa.** Tres razones, en orden de peso: la **semántica ya la fijó quien la pidió** (el issue propone `defaultField`, declara el fail-safe y **descarta con argumento** la alternativa del mini-lenguaje de fechas `default: today+1w`, así que no hay bifurcación viva que elegir); el cambio es **aditivo** (un campo opcional; ningún spec existente cambia de comportamiento); y hay un **requisito de usuario real bloqueado** — PI-12 no puede cumplir su §2.4 y el *workaround* vigente le rompe la promesa al usuario que la pidió.
- **Lo que sí decidí yo, y va en el documento de diseño** (`work/011-235-default-del-dato/01-diseno-defaultfield-v1.0.md`), porque el issue no lo contempla: el **criterio de verdad** del booleano es una **lista cerrada** y no truthiness de JS (`String(false)` es `'false'`, que es truthy — la trampa concreta); «exactamente una» se cuenta sobre **opciones deduplicadas**, no sobre filas; el valor del dato entra por el **mismo camino que el literal de #92** para heredar gratis la precedencia de la URL; y la ausencia de resolución **emite evento**, porque un fail-safe sin observabilidad es un silencio.
- **#246 es prerrequisito, no vecino**: el `enum` del JSON Schema que dejó muerto al literal de #92 bloquearía igual cualquier `default` nuevo, y el hueco de validación que permite claves desconocidas en silencio haría que un typo en `defaultField` no dijera nada. Los dos tocan la misma línea.
- **Costo de revertir**: medio. Es código con tests y un campo de contrato público; revertirlo después de que un spec de instancia lo use rompería ese spec. Antes de eso, es un revert limpio.
<!-- segundo-ojo · Correcta — diseño e implementación verificados; enum abierto deja typo silencioso · 2026-09-05 · juez Fable 5.1 · sha12 2687c4fde36a · soveria-ai/audits/veredictos-20260905/ -->

## D-52 · 2026-08-19 — El healthcheck por fase también va al compose de REFERENCIA

- **Bifurcación**: el defecto (`r.ok` dando sano a un `standby`) estaba en `docker-compose.yml`. ¿Se arregla solo ahí, o también se agrega el healthcheck —que no existía— al servicio `vergis` de `deploy/compose.reference.yml`?
- **Decidido**: **también en el de referencia.** El argumento en contra es serio y se evaluó: ese archivo describe una instancia **con anillos**, donde el borde ya juzga la salud por el predicado correcto y los anillos viven fuera del ciclo de vida de compose, así que un healthcheck ahí podría leerse como «compose es el mecanismo de ruteo». Ganó el otro: **el archivo documenta explícitamente el modo de un solo nodo**, y en ese modo el servicio `vergis` *es* el que sirve — un `docker ps` diciendo `healthy` sobre un standby es la mentira más cara que esa plantilla puede contar, justo cuando el operador la mira porque algo anda mal.
- **La mala lectura se desarma por escrito en el propio archivo**, no en el commit: que es diagnóstico y **no** ruteo, y que los anillos no lo heredan porque `ring.args` no lleva healthcheck y su salud la mide el borde, el único que puede *actuar* sobre ella.
- **Costo de revertir**: nulo — borrar el bloque.
<!-- segundo-ojo · Correcta — predicado idéntico en ambos compose; refutador standby FALLO · 2026-09-05 · juez Fable 5.1 · sha12 0856325f0a58 · soveria-ai/audits/veredictos-20260905/ -->

## D-51 · 2026-08-19 — Los dos PRs de Renovate NO se mergean: el cooldown de supply chain está corriendo

- **Bifurcación**: #201 (`python:3.12-slim-bookworm`) y #175 (`caddy:2`) tienen `test` y `review` en verde y la custodia autoriza aterrizar PRs de bot. ¿Se mergean?
- **Decidido**: **no**, y no por prudencia genérica: **`renovate/stability-days` está en `pending`** en los dos, con el mensaje «Updates have not met minimum release age requirement». Ese check es el **cooldown de `minimumReleaseAge: "14 days"`** del ADR-001, y es un control declarado a propósito contra compromisos de supply chain. #175 tiene 6 días y #201 tiene 2: ninguno cumple. Mergearlos sería **anular un control que costó tres días hacer visible** — el mismo que estuvo inerte hasta que se descubrió el 403 que abortaba a Renovate con el job en verde.
- **Y no son «casi trámite»**: el job `image` está **SKIPPED en pull requests** (verificado), así que el digest nuevo del sidecar de PDF **no se construye en el PR**. Un digest roto se descubriría en `main`. Con el cooldown corriendo, no hay ninguna razón para adelantarlo.
- **Qué los destraba**: que el check pase por sí solo al cumplirse los 14 días. Ahí sí son trámite y se aterrizan con gates.
- **Costo de revertir**: nulo — es una no-acción.
<!-- segundo-ojo · Correcta con salvedad medible: el check no pasó solo; siguen pending · 2026-09-05 · juez Fable 5.1 · sha12 58cb3ce64a4a · soveria-ai/audits/veredictos-20260905/ -->

## D-50 · 2026-08-19 — La entrada I7+I8 de anillos se MUEVE a la sección 0.21.0 del CHANGELOG (#242)

- **Bifurcación**: el tag `v0.21.0` **contiene** el código de #233 (el conmutador de anillos, I7+I8) —medido con `git merge-base --is-ancestor f6b1295 v0.21.0`— pero el corte dejó su entrada bajo «Sin publicar». Dos salidas: **(a)** mover la entrada a 0.21.0, o **(b)** declarar que la exclusión fue criterio deliberado («no se declara hasta que sea operable con su runbook») y dejarla donde está.
- **Decidido**: **(a)**. Declarar **qué trae una versión** es competencia de este repo (`CLAUDE.md` §«La frontera»), y una sección de versión que omite un mecanismo que su tag sí contiene no es una omisión inocua: en el corte siguiente esa entrada se habría movido a la versión nueva, **declarando bajo 0.22.0 un mecanismo que viajó en 0.21.0**. La declaración de esa versión habría nacido falsa, y el operador que planifica por CHANGELOG habría decidido con un dato falso.
- **Por qué NO (b)**: el criterio «no se declara hasta que sea operable» no consta en ninguna parte —ni `DECISIONS.md` ni la bitácora lo registran— y **la convención vigente lo contradice**: I4+I5+I6 se declaró bajo 0.20.0 y #220/#222 bajo 0.19.0, ambas sin runbook. Inventarle el criterio a posteriori para justificar el estado sería fabricar la justificación que la Norma 6 prohíbe.
- **Lo que NO se corrige, y va escrito en la propia entrada**: la imagen `0.21.0` ya horneó el CHANGELOG sin esta entrada. No se re-taggea una versión publicada, así que para ese tramo la fuente es el repo. Queda dicho en el CHANGELOG, no solo acá.
- **Costo de revertir**: bajo — es un movimiento de bloque en un archivo de texto, sin código. Revertirlo devuelve el defecto.
<!-- segundo-ojo · Correcta — ancestría re-medida; entrada hoy bajo 0.21.0 con nota · 2026-09-05 · juez Fable 5.1 · sha12 bb6300ee60e1 · soveria-ai/audits/veredictos-20260905/ -->

## D-46 · 2026-08-19 — El centinela de #238 NO se retira en el `teardownSQL`

- **Bifurcación**: el emisor es simétrico por doctrina —todo lo que el setup instala, el teardown lo desinstala— y hay un test que lo sostiene. ¿El centinela sigue esa simetría?
- **Decidido**: **no**. El centinela es **compartido por schema**, no propiedad de una tabla: retirarlo al desinstalar la política de UNA tabla dejaría ciegas a todas las demás del mismo schema — el instrumento moriría por un acto que no lo nombra. Se expone `dropSQL` para el retiro explícito.
- **Corolario que va en la misma línea**: su instalación es **crear-si-falta**, no tira-y-recrea. La forma habitual abriría una ventana en la que un sondeo concurrente lee una tabla ausente, y el gate lo traduciría a «no pude medir» — correcto pero ruidoso, y provocado por nosotros.
- **Costo de revertir**: bajo (mover tres sentencias), pero reintroduce las dos ventanas.
<!-- segundo-ojo · Correcta — teardown sin centinela, dropSQL expuesto, crear-si-falta medido · 2026-09-05 · juez Fable 5.1 · sha12 ecc12062ae6e · soveria-ai/audits/veredictos-20260905/ -->

## D-47 · 2026-08-19 — «Centinela no instalado» es indeterminación, no veredicto

- **Bifurcación**: el gate distingue veredicto definitivo de indeterminación. Un PI con reglas de columna en una instancia que **todavía no regeneró su DDL** no tiene centinela. ¿Eso es «no-servible» (definitivo) o «no pude medir»?
- **Decidido**: **indeterminación**, con su remediación nombrada («regenera y re-aplica la DDL»). Un PI que YA servía conserva su veredicto sano; en frío queda no-servible. Apagar un PI sano por una migración pendiente sería castigar con un corte de servicio algo que no es una falla de gobierno sino una **ausencia de medición** — y la doctrina del gate ya separa esas dos cosas desde #52.
- **Lo que NO se aflojó**: capacidad **medida ausente** (`incapable`) es veredicto **definitivo** y gana sobre un veredicto sano previo. Ningún camino afloja el fail-closed.
- **Costo de revertir**: bajo (una condición), pero apagaría PIs sanos en toda instancia que no haya re-aplicado.
<!-- segundo-ojo · Correcta — uninstrumented indeterminado, incapable definitivo, medido en el gate · 2026-09-05 · juez Fable 5.1 · sha12 40ca990f4ea7 · soveria-ai/audits/veredictos-20260905/ -->

## D-48 · 2026-08-19 — Los schemas del sondeo los pone el llamador, no se descubren en el motor

- **Bifurcación**: el motor podía descubrir solo dónde vive el centinela con una consulta previa, o recibir los schemas del llamador (que ya tiene el policy store).
- **Decidido**: **los pone el llamador**. Descubrirlos exigía una consulta previa, y eso convertía el arranque en frío en **dos olas** de round-trips en vez de una — justo el costo que #138·3 acotó. Y no es teoría: la primera versión de la implementación lo hizo así, ningún test funcional lo notó, y lo atrapó el test de tiempo. Quedó un test de regresión propio (E4).
- **Costo de revertir**: bajo, y se paga en latencia de arranque en frío proporcional al número de conexiones.
<!-- segundo-ojo · Correcta — una ola; E4 corrido en clon, 6/6 verdes · 2026-09-05 · juez Fable 5.1 · sha12 fbd240397cd0 · soveria-ai/audits/veredictos-20260905/ -->

## D-49 · 2026-08-19 — La distinción de literales (`•••` vs `xxxx`) NO se escribe en el SQL emitido

- **Bifurcación**: el diseño pedía documentar en el **header emitido de la vista** que el literal de la vista (`•••`) es deliberadamente distinto del que rinde el DDM (`xxxx`), para que el literal delate qué capa enmascaró.
- **Decidido**: se documenta en el **tipo, la doc del contrato y el CHANGELOG**, y **no** en el SQL. `CREATE VIEW` tiene que encabezar su batch en T-SQL; anteponerle un comentario es aceptado por SQL Server pero **no está medido en Fabric**, y el emisor ya se quemó una vez publicando DDL que el motor acepta y después falla al consultar (#197). El valor de un comentario que nadie lee en runtime no justifica arriesgar la emisión.
- **Es una desviación del diseño ratificado, y consta como tal.** Si se quiere el comentario, primero se mide en el SKU.
- **Costo de revertir**: bajo — una línea en el emisor y una corrida de `fab:proof` que la mida.
<!-- segundo-ojo · Correcta — SQL sin comentario; distinción en tipo, doc y CHANGELOG · 2026-09-05 · juez Fable 5.1 · sha12 4dd81d270144 · soveria-ai/audits/veredictos-20260905/ -->

## D-42 · 2026-08-18 — Se corta 0.20.0, primera versión bajo custodia declarada

- **Bifurcación**: César aprobó que el cableado entrara «con una 0.20.0 detrás». ¿Se mergea #225 y se corta, o se espera a que la serie de anillos cierre entera (faltan I7+I8: el conmutador del borde y la herramienta de anillos)?
- **Decidido**: **mergear y cortar**. La instrucción era explícita, y el frente arbol quedó **bloqueado** por la custodia recién declarada — no puede mergear lo suyo, y I7+I8 apuntarían a una superficie que no existe en `main`. Esperar habría dejado su trabajo detenido sin ganar nada: 0.20.0 es publicable por sí sola (un nodo suelto se comporta igual que antes).
- **Costo de revertir**: bajo — la versión anterior sigue publicada y es un pin válido; el `latest` se movería con un corte nuevo.
- **Lo que este corte estrena**: es la **primera versión bajo la custodia** (`CLAUDE.md` §«La custodia»). El ciclo completo se ejerció el mismo día en que la norma nació — arbol avisó antes de abrir, no tocó el merge y declaró sus «sin medir»; este frente corrió los gates **por su mano** antes y después del merge, verificó la afirmación de «cero `bindColumn`» en vez de aceptarla, y agregó al CHANGELOG una advertencia que **no venía en el PR** (el healthcheck que da por sano a un `standby`).
- **Y lo que el corte produjo**: el smoke de la imagen publicada encontró el **issue #228** — un arranque que falla después de adquirir el lease lo deja huérfano y sin marca de release. Es un camino de fallo que ninguna verificación previa ejercía, y apareció **porque** el custodio corre la imagen, no solo la suite.
<!-- segundo-ojo · Correcta — primera versión bajo custodia; advertencia no venía en #225 · 2026-09-05 · juez Fable 5.1 · sha12 ac93fedcec7e · soveria-ai/audits/veredictos-20260905/ -->

## D-41 · 2026-08-18 — Se corta 0.19.0 SIN el frente que cablea los planos de anillos

- **Bifurcación**: César instruyó «corta». Minutos después, el frente arbol/lab avisó que tenía listo, rebasado y verde (2275/2275, con medición de dos nodos reales) el frente que **invoca** los planos de #220/#222 —lazos de fondo, `standby` en `healthz`, 409 en mutaciones sin control, bloque `control` en `/contrato`— y ofreció mergearlo antes del corte. ¿Entra o espera?
- **Decidido**: **espera**. César autorizó el corte **sin saber que ese frente existía**, y no es cosmético: cambia lo que un operador ve al desplegar. Meterlo ampliaría el alcance de lo autorizado, y esa decisión es suya. Con la espera, además, la línea del CHANGELOG —«los planos están puestos y nada los invoca todavía»— queda **exacta** en vez de nacer falsa. Sale en su propia versión si él lo quiere.
- **Costo de revertir**: nulo — la rama del otro frente espera intacta; si César lo quiere publicado, sale 0.20.0 detrás.
- **Coordinación acordada con arbol/lab, en los dos sentidos**: se avisa **antes** de abrir PR, no después de mergear. Nace de que hoy los dos frentes escribieron `gegolabs/vergis` sin saberlo (W-01, ocurrencias 24 y 25) — y de que el aviso tardío de #223 casi le cuesta un CI rojo a él.
<!-- segundo-ojo · Correcta — cronología y CHANGELOG del tag verificados · 2026-09-05 · juez Fable 5.1 · sha12 3255f6be7681 · soveria-ai/audits/veredictos-20260905/ -->

## D-40 · 2026-08-18 — `bindColumn` se RETIRA del contrato en vez de aceptarse e ignorarse (#164)

- **Bifurcación**: con el allow-all ya sin ancla, ¿qué pasa con `FabricTarget.bindColumn`? Tres caminos: ignorarlo en silencio (retrocompatible), conservarlo como escape hatch que emite la forma vieja, o retirarlo del contrato (rompe a quien lo pase).
- **Decidido**: **retirarlo**, con guarda de transición que rompe con remediación. César delegó la decisión pidiendo criterio de excelencia, y la Regla 1 la contesta: si nada estuviera implementado, un allow-all no declararía columna alguna — el campo es andamiaje de una limitación que ya no existe, y el proyecto sigue pre-launch (un beta tester es piloto controlado). El escape hatch se descartó por no tener necesidad medida: la forma sin columna pasó en **los dos motores** que el back-end sirve, no en uno. Y no se ignora en silencio porque el silencio le dejaría creer al aplicador que su ancla sigue en pie.
- **Costo de revertir**: bajo — reponer el campo y la rama de codegen vieja; nada desplegado depende del retiro.
<!-- segundo-ojo · Correcta — guarda fabric.ts L682-693; control negativo falla test L485 · 2026-09-05 · juez Fable 5.1 · sha12 2f359d7b8489 · soveria-ai/audits/veredictos-20260905/ -->

## D-39 · 2026-08-18 — El CHANGELOG de #164 INDICA los pasos de migración, no los sugiere

- **Bifurcación**: los 34 `ADD FILTER PREDICATE` desplegados conservan su ancla. ¿El changelog lo declara como opcional, lo recomienda, o lo indica como acción a ejecutar?
- **Decidido**: **indicarlo**, con sus pasos y su verificación, dejando el *cuándo* al control de cambio del operador. Es de César: él observó que el criterio de excelencia no decide la interacción con terceros, y que ahí lo correcto es indicar —más que sugerir— las acciones que aseguran que el valor entregado no corra riesgo. Lo que lo vuelve obligatorio en este caso: el cambio **apaga un aviso**. El compilador declara lo que emite, no lo instalado, así que hasta re-aplicar, un `grant: all` reporta cero dependencias mientras su columna sigue atada en el motor — el gate de regresión de terreno del operador quedaba ciego sobre un bloqueo real, sin que nadie se lo dijera.
- **Costo de revertir**: nulo — es texto del CHANGELOG, aún sin versión cortada.
- **Consecuencia fuera del proyecto**: la observación se elevó a enmienda de la Regla 1 de `ww:wingcoding` (repo `protocolos`, PR #1). **No se mergea desde acá**: el Reglamento lo escribe César.
<!-- segundo-ojo · Correcta — CHANGELOG L1205-1221 indica pasos; protocolos PR #1 sigue abierto · 2026-09-05 · juez Fable 5.1 · sha12 1dee1540e065 · soveria-ai/audits/veredictos-20260905/ -->

## D-38 · 2026-08-18 — La ventana de capacidad se aprovecha entera: P7 (#164) se agrega ANTES de encender

- **Bifurcación**: César autorizó correr el experimento. ¿Encender y correr solo P6, o agregar primero la medición de #164 —que estaba anotada como pendiente— y contestar dos preguntas en una ventana?
- **Decidido**: agregar P7 antes de encender. El costo de la ventana es por sesión, no por experimento: encender dos veces para dos preguntas que caben en una es gasto puro. Lo confirmó el propio pedido de César («todos»).
- **Costo de revertir**: nulo — el arnés crece, no cambia comportamiento del Producto.
<!-- segundo-ojo · Correcta — P7 en c21ac7e; ventana 07:10-07:20 con P6 y P7 medidos · 2026-09-05 · juez Fable 5.1 · sha12 7b6ab081346d · soveria-ai/audits/veredictos-20260905/ -->

## D-37 · 2026-08-17 — Los PRs de bot en cooldown NO se aterrizan, aunque sus otros checks estén verdes

- **Bifurcación**: #175 y #201 tenían `test` y `review` en verde y solo `renovate/stability-days` en `PENDING`. ¿Aterrizarlos igual, o esperar?
- **Decidido**: esperar. `minimumReleaseAge: "14 days"` es política de supply chain del proyecto, no preferencia, y su objeto son exactamente las dependencias de terceros como un digest de Docker. Se comentó en cada PR que no hay nada que corregir: solo falta tiempo. La única excepción declarada (`osvVulnerabilityAlerts`) no aplica — son bumps de rutina sin alerta asociada.
- **Costo de revertir**: nulo — se mergean cuando el check pase a verde.
<!-- segundo-ojo · Correcta con salvedad medible — #175/#201 siguen pending 23 dias despues · 2026-09-05 · juez Fable 5.1 · sha12 93c6216db3b7 · soveria-ai/audits/veredictos-20260905/ -->

## D-36 · 2026-08-17 — El compilador de Fabric NO se toca por #197: se entrega el experimento

- **Bifurcación**: #197 dejó el defecto aislado y la forma alternativa es deducible (materializar el claim antes del `CASE`). ¿Implementar el rediseño, o construir solo el experimento?
- **Decidido**: solo el experimento (P6 en `fab:proof`, PR #217). La forma que funciona en SQL Server **no garantiza Fabric** —es la asimetría que este mismo issue documentó—, y emitir una forma nueva sin verla pasar en el SKU es literalmente lo que produjo el defecto. Correr P6 exige encender la capacidad F2, y eso es **gasto**: no lo decide el agente.
- **Costo de revertir**: nulo — no se cambió comportamiento. El experimento está en el árbol esperando ventana.
<!-- segundo-ojo · Correcta — #217 solo scripts; compilador intacto hasta #221; gasto del principal · 2026-09-05 · juez Fable 5.1 · sha12 74b9f0d6e47f · soveria-ai/audits/veredictos-20260905/ -->

## D-35 · 2026-08-17 — `colorscale` del spec no se elimina: cambia de significado a «acota candidatas»

- **Bifurcación**: #210 pide que el color de magnitud deje de ser decisión del spec. Tres caminos: quitar la clave (rompe specs), dejarla como no-op silencioso, o darle un rol nuevo.
- **Decidido**: rol nuevo — `colorscale: true` **acota** las columnas candidatas al color; el poder de **encender** pasa al lector. Racional: quitarla rompería specs de instancias por una razón de presentación, y un no-op silencioso dejaría el spec diciendo algo que ya no ocurre — la peor de las tres, porque no falla.
- **Costo de revertir**: bajo — es una condición en `magnitudeColumns` con su suite.
<!-- segundo-ojo · Correcta — magnitudeColumns acota; control negativo hace fallar 2 tests · 2026-09-05 · juez Fable 5.1 · sha12 38c01ed725a3 · soveria-ai/audits/veredictos-20260905/ -->

## D-34 · 2026-08-17 — El override del nombre visible gana sobre el spec, y se declara como override

- **Bifurcación**: #207 §1, «¿dónde queda la verdad?» cuando el YAML y el gobierno traen nombres distintos.
- **Decidido**: gana el gobierno, **pero** el nombre del spec se conserva (`Report.specName`) y la consola dice que está sobrescrito, contra qué y por quién. Restaurar **borra** la fila en vez de guardar el nombre del spec — guardarlo congelaría el de hoy y una edición posterior del YAML no se vería nunca más.
- **Costo de revertir**: medio — hay tabla nueva (`pi_display_name`), pero borrarla vuelve todo al nombre del spec sin pérdida.
<!-- segundo-ojo · Correcta — pi_display_name, restaurar DELETE, test L121, specName servido · 2026-09-05 · juez Fable 5.1 · sha12 cc4c2ff7ef7c · soveria-ai/audits/veredictos-20260905/ -->

## D-33 · 2026-08-17 — El pliegue largo→ancho de #203 vive en `compose`, no en un segundo renderer

- **Bifurcación**: para `series: <campo>` (formato largo), ¿un camino de render propio o plegar a la forma que el render agrupado ya consume?
- **Decidido**: plegar en `compose`. Un segundo renderer tendría que replicar apilado, rótulos anti-colisión, cota top-N y el vocabulario de `sort`, y las dos copias divergirían en la primera corrección. Así los dos modos se comportan idéntico **por construcción**.
- **Costo de revertir**: bajo — es una rama en `composePiece` con su función pura testeada.
<!-- segundo-ojo · Correcta — foldSeriesColumn pura en compose.ts, suite verde en clon · 2026-09-05 · juez Fable 5.1 · sha12 ede54b1bf819 · soveria-ai/audits/veredictos-20260905/ -->

## D-32 · 2026-08-17 — Se corta y publica 0.18.0 (CHANGELOG + version + tag + imagen)

- **Bifurcación**: dejar los cuatro frentes en `main` sin versión, o cortar 0.18.0.
- **Decidido**: cortar y publicar. Sin versión, lo único que un operador puede consumir es el último commit de `main` — y entonces mergear *es* desplegar, que es lo que la frontera de `CLAUDE.md` existe para impedir (D-28). El CHANGELOG declara explícitamente que **#197 sigue vivo y esta versión no lo arregla**.
- **Costo de revertir**: bajo — el tag se puede re-cortar; **nada desplegado**: qué versión corre cada instancia y cuándo entra lo decide quien la opera.
<!-- segundo-ojo · Correcta — tag v0.18.0 e79c2cd; CHANGELOG L1269 declara #197 vivo · 2026-09-05 · juez Fable 5.1 · sha12 a3fb860890bf · soveria-ai/audits/veredictos-20260905/ -->

## D-31 · 2026-08-16 — El merge de lo confirmado deja de subir a César

- **Bifurcación**: `CLAUDE.md` decía «el merge es acto de César», y la sesión de hoy terminó pidiéndole el merge de #196 —un PR con typecheck, 2125 tests, build y CI verdes, corrido además contra el motor real—. Su corrección, textual: *«no quiero que me preguntes más por hacer merge a soluciones que fueron confirmadas resuelven un problema»*.
- **Decidido: el agente mergea lo confirmado**, y *confirmado* queda definido para que no se estire: gates verdes, CI verde y **evidencia medida** de que el problema quedó resuelto. Sin la medición no hay merge — mergear sin ella sería afirmar más de lo medido, que es lo que la Norma 7 persigue.
- **Por qué la línea queda ahí y no más allá**: lo que sube a César es lo que **es** decisión suya —gasto, comunicación saliente a un tercero, una bifurcación de diseño todavía viva, un PR ajeno—, no lo que solo es un clic. Es la misma economía que ya regía para el cierre de issues desde el 2026-08-14: el pasivo no se acumula por un trámite, y si al verlo considera que no correspondía, revierte.
- **Costo de revertir**: bajo. La norma vive en un párrafo de `CLAUDE.md`; volver atrás es restaurarlo. Los merges hechos bajo ella conservan su PR y su historia, y `git revert` sigue disponible.
<!-- segundo-ojo · Correcta — norma en CLAUDE.md L56-73, PR #198 dos minutos tras #196 · 2026-09-05 · juez Fable 5.1 · sha12 72bedcefba1e · soveria-ai/audits/veredictos-20260905/ -->

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
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 1fcbd9d9163e · soveria-ai/audits/veredictos-20260905/ -->

## D-29 · 2026-08-14 — El esquema del Producto admite Z: la corrección se publica sin capacidades nuevas

- **Bifurcación**: el preámbulo del `CHANGELOG` declaraba esquema **X.Y** (sin Z), pero 0.9.1 existía como precedente y la tabla de tags de 0.16.0 prometía que `:0.16` «flota al último patch» — dos afirmaciones incompatibles en el mismo archivo, introducidas por esta sesión. ¿Se admite la Z, o se retira la promesa del tag `0.16` y el fix viaja en la próxima Y?
- **Decidido por César** (2026-08-14): **se admite la Z** — corrección sin capacidad nueva. Queda coherente con 0.9.1, con la tabla de tags y con el `type=semver,pattern={{major}}.{{minor}}` del CI.
- **Por qué, y el caso que lo prueba**: el fix de #139 corrige un contrato que **inducía a operar mal** (declaraba `bootOnly` una clave recargable, o sea «reiniciá» cuando no hacía falta). Es exactamente el cambio que un operador querría adoptar **aislado**; sin Z, la única forma de dárselo era obligarlo a tomar una Y completa con capacidades que todavía no evaluó.
- **Se deja escrito lo que se iba a confundir**: la Z del Producto **no** es la Z de la Norma 3 de la Ley (que rige documentos y significa «solo cambió la forma»). Acá un cambio cosmético de código no se publica solo; lo que merece número propio es la corrección adoptable aislada.
- **Costo de revertir**: bajo — es el preámbulo del changelog más una línea de la lista de tags del CI. Lo que no se revierte gratis son las versiones ya publicadas con ese número.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 6ad60a211680 · soveria-ai/audits/veredictos-20260905/ -->

## D-28 · 2026-08-14 — Acá se es el Producto: se publica la versión, no se despliega la instancia

- **Bifurcación**: la sesión cerró #178 y reportó como pendiente «falta el despliegue a la instancia». César lo corrigió: en este proyecto representamos el **Producto** y manipulamos el repo; no somos el usuario con acceso a la VM. ¿El entregable termina en el merge, en la versión publicada, o en el despliegue?
- **Decidido por César** (2026-08-14): **termina en la versión publicada, con su changelog y su aviso.** El descargue y el despliegue son del cliente —en este caso el agente que atiende A.R.B.O.L.— con su política de control de cambio. Canal de aviso **por ahora**: solo el GitHub Release; la lista de correos se define después.
- **Por qué no es una división de tareas**: un despliegue toca datos, disponibilidad y ventanas de un tercero. Esa autoridad no es de quien escribe el código. La norma queda en `CLAUDE.md` (se carga en toda sesión de este repo) y la cara al cliente en el preámbulo del `CHANGELOG.md`.
- **La condición material de la frontera, medida**: la frontera no existía técnicamente. `latest` se movía en **cada push a `main`** y los dos compose que gobiernan el deploy apuntan a ese tag (verificado en el repo del lab: `deploy/mira-vm/compose.yml:15` y `mira-vm-qa/compose.yml:11`) — así que un merge entraba en el siguiente recreate sin acto nuestro ni control de cambio suyo. Y no había alternativa: entre 0.15.0 y HEAD no existía versión que el operador pudiera **nombrar**. Corregido en 0.16.0: los tags que un consumidor pinnea los mueve un tag de git. *Alcance de lo verificado: el repo del lab, no el compose vivo en la VM.*
- **La política de tags se validó contra práctica de industria**, a pedido de César y no por criterio propio: `latest` reservado a releases estables con los builds de desarrollo en tag aparte, y el consumidor pinneando versión exacta o digest (ACR · Docker tagging best practices · Container Registry · Mend). De ahí salió el tag en cascada `0.16`, que la propuesta original no traía. Se dejó fuera `:0`: pre-1.0 el eje de ruptura es la Y del esquema X.Y, así que prometería compatibilidad que nadie sostuvo.
- **Lo que NO se revirtió**: la decisión de `9beeda8` (plantilla con tag móvil, sin digest) sigue en pie — es otra palanca, y con esta política el `:latest` de la plantilla por fin significa lo que ese commit quería que dijera.
- **Costo de revertir**: bajo en lo técnico (la lista de tags de `build.yml` es cinco líneas) y **nulo** en lo normativo: la frontera es una declaración de autoridad; se cambia diciéndolo.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 62d524c220b3 · soveria-ai/audits/veredictos-20260905/ -->

## D-27 · 2026-08-13 — La vista de máscara y el DDM conviven, y la composición falla hacia el lado seguro

- **Bifurcación**: la vista de máscara (H6) honra el claim por request; el `MASKED WITH` (H2) enmascara igual para todos. Pero **la vista lee la columna base**: si el Service Principal del pool **no** tiene `UNMASK`, la rama «en claro» de la vista devuelve igual el default de DDM y **el sujeto CON el claim tampoco ve el valor**. ¿Se emiten los dos, o se retira el DDM sobre las columnas que la vista cubre?
- **Decidido**: **se emiten los dos.** La composición gana siempre el más restrictivo, así que el peor caso es **sobre-enmascarar**, nunca filtrar. Y cada uno cubre una topología distinta: la vista protege a quien se sirve por ella —el único camino que discrimina por sujeto—; el DDM protege a quien consulta **la tabla base**, que es el camino que queda si el spec no apunta a la vista.
- **El costo asumido, dicho**: si el SP no tiene `UNMASK`, la capacidad queda degradada a «esta columna no se sirve a nadie» — que es la herramienta gruesa de la que el issue se queja, pero **es segura**. Retirar el DDM para evitarlo cambiaría una degradación segura por una fuga posible, y esa no es una permuta que se haga sin medir.
- **La medición que lo destraba, y va antes de desplegar**: ¿el Service Principal de serving tiene `UNMASK`? Se mide en `vm-vergis-qa`, **en la misma sesión** que una consulta a la tabla sin vista como control positivo. Está en `PENDINGS.md` junto al gate de `MASKED WITH` × vistas-contrato.
- **Costo de revertir**: bajo — no emitir DDM sobre columnas cubiertas por la vista es una condición en el emisor.
<!-- segundo-ojo · Correcta con salvedad medible: la medición prometida en vm-vergis-qa no consta · 2026-09-05 · juez Fable 5.1 · sha12 83bd835616ac · soveria-ai/audits/veredictos-20260905/ -->

## D-26 · 2026-08-13 — La apertura de fila sube a la ENTIDAD, para que el caso del issue se pueda decir

- **Bifurcación**: en la forma canónica un dataset `grant: all` no realiza entidad, así que no había atributo canónico que mapear y un `columns:` rompía con `grant-columns-unsupported`. La capacidad quedaba solo en la forma legacy — y con ella **el caso que origina #163**: la entidad `empleado`, abierta por decisión del cliente, con `rut` y nombre servibles a cualquier autenticado. ¿Se admite una regla inline en el dataset, o se mueve la apertura?
- **Decidido**: `entities[].grant: all` — **la apertura sube a la entidad** y convive con `columns`. Un solo sitio de autoría, la misma gramática, y `grant: all` conserva intacta su semántica de fila (apertura explícita y gobernada, con artefacto propio). La regla inline se descartó porque duplicar el sitio de autoría garantiza que las dos copias divierjan.
- **Evidencia**: la entidad ya era el sitio único del gobierno (`governed_by` ↔ `dimensions`) y ya sabía llevar reglas de columna sobre atributos canónicos; poner ahí la apertura reusa esa maquinaria entera. Y el default sigue siendo romper: una entidad sin gobierno **y** sin apertura sigue dando `entity-ungoverned`.
- **Costo de revertir**: medio — hay specs que podrían adoptar la forma. Mientras nadie la use, es una rama de parseo que se retira.
<!-- segundo-ojo · Correcta con salvedad de ficha: evidencia sin etiquetar, medida en código · 2026-09-05 · juez Fable 5.1 · sha12 b535319010c8 · soveria-ai/audits/veredictos-20260905/ -->

## D-25 · 2026-08-13 — Una regla de columna sobre ClickHouse tumba el arranque, y se le da SITIO

- **Bifurcación**: el back-end ClickHouse rechaza las reglas de columna (D-24). ¿Ese rechazo debe degradar a «ese PI no se sirve» —doctrina de #52— o tumbar el arranque del nodo?
- **Decidido**: **tumba el arranque**, sin doctrina nueva. Medido el precedente: en `computeBound`, la línea de al lado ya tumba el arranque cuando un dataset **no tiene política**. El fallo duro es la conducta establecida de ese motor y es fail-closed; la doctrina por-PI de #52 es de la verificación de servibilidad de **Fabric**, no del bootstrap de ClickHouse. Cambiarla acá habría sido inventar una excepción para el caso nuevo.
- **Lo que sí faltaba**: el **sitio**. El error del compilador llegaba sin nombrar el dataset, y el sitio es la mitad del diagnóstico. Se envuelve agregando el nombre y **conservando la causa original entera** (`cause`), con un control que fija que el envoltorio no se traga los errores que ya existían.
- **Costo de revertir**: nulo — es un `try/catch` que agrega contexto.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 da2cb26ecc5e · soveria-ai/audits/veredictos-20260905/ -->

## D-24 · 2026-08-13 — ClickHouse declara la máscara NO SOPORTADA en vez de fingirla

- **Bifurcación** (§4.1 del diseño la dejaba abierta): ¿el back-end ClickHouse enmascara en la proyección, o declara la capacidad no soportada?
- **Decidido**: **no soportada, fail-closed al compilar**, con evidencia del propio código: el enforcement emite **solo** `CREATE ROW POLICY … USING <expr>`, que es un **predicado booleano por fila** —decide si la fila pasa, no qué valor lleva la celda—; la proyección **no la escribe el compilador** (`execute-sql-ch.ts` manda el `SELECT` del consumidor verbatim); y el aplicador solo aplica `rowPolicySQL`. Lo más cercano del motor, `GRANT SELECT(col)`, **retira** la columna: cambiaría la forma del resultado, que es justo lo que §4.1 descarta.
- **La consecuencia se acepta**: un PI con columna sensible sobre ClickHouse **no se sirve**. Es estrictamente mejor que la alternativa —servirlo en claro— y la remediación del error lo dice de frente para que nadie «arregle» el problema retirando la regla.
- **Lo que NO está medido, y va dicho**: que ClickHouse carezca de un equivalente de `MASKED WITH` no se corroboró contra un motor vivo. Lo medido, que es lo que sostiene la decisión, es que **este back-end no controla la proyección** — y eso es del código de este repo.
- **Costo de revertir**: bajo — es un gate en el compilador.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 39d5138ec7dd · soveria-ai/audits/veredictos-20260905/ -->

## D-23 · 2026-08-13 — El valor de máscara es del BACK-END; el oráculo conserva un centinela

- **Bifurcación**: el hito 1 fijó `MASK_VALUE = '•••'`, pero Fabric `MASKED WITH` devuelve el default **del tipo** (`0` en `INT`, `XXXX` en texto). El differential test chocaría. Las dos salidas obvias son malas: un valor de máscara por tipo convierte la constante en función y contamina el IR con tipos SQL; castear la columna a texto **cambia el esquema**, que §4.1 prohíbe.
- **Decidido**: **el valor de máscara pertenece al back-end; el IR conserva `•••` como centinela canónico, y cada emulador normaliza a centinela** lo que su motor produce antes de comparar. Así hay un solo oráculo, cada motor enmascara nativamente, y el esquema no se toca. El differential test afirma la **posición** de la máscara, jamás su contenido.
- **Costo de revertir**: bajo — la normalización vive en los emuladores, no en el SQL emitido.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 9a0e92f4744d · soveria-ai/audits/veredictos-20260905/ -->

## D-22 · 2026-08-13 — Los specs del canon NO se migran: se citan

- **Bifurcación**: `TODO.md` y el README declaraban pendiente «migrar los specs normativos del canon (contrato Botler, spec Mira, DSL, naming) de AgencyDomains a `docs/`». ¿Se migran, o la premisa cambió?
- **La premisa re-derivada contra el terreno**: **no existen archivos-spec sueltos que mover**. Lo normativo vive dentro del **libro publicado** *AgencyDomains · Arquitectura del Mundo Agentivo* (v1.0, agosto 2026, agencydomains.org). Buscar «contrato Botler» o «spec Mira» como documentos en ese repo no devuelve nada: la migración estaba enunciada sobre artefactos que no existen con esa forma.
- **Decidido**: **no se migran; se citan.** Dos razones, y la primera es un hecho verificable, no una preferencia:
  1. **Las licencias no mezclan.** El libro es **GNU FDL v1.3**; este repo es **AGPL-3.0-or-later**, y la FDL no es compatible con la GPL. Copiar el texto normativo acá volvería una parte del árbol no redistribuible bajo su propia licencia — un defecto que solo aparecería el día que alguien redistribuyera.
  2. **Un spec con dos casas driftea**, y la copia siempre pierde porque es la que nadie relee. Este proyecto ya pagó esa factura: la línea del port a Go en `TODO.md` era un duplicado de una decisión del ADR-001 y envejeció peor que su fuente.
- **Hecho en su lugar**: `docs/canon.md` — dónde vive el canon, qué edición se cita, por qué no se copia, qué queda en `docs/` (lo verdadero de ESTA implementación), y la regla ante desacuerdo: el canon manda sobre *qué es* un Botler/Mira/DSL, el repo manda sobre *qué hace* esta implementación. Más el camino si algún día hace falta un fragmento in-tree: relicenciamiento explícito del autor (César tiene el copyright de ambas obras) registrado en un ADR — un acto, no un copy-paste.
- **Costo de revertir**: nulo — migrar sigue siendo posible el día que exista el acto de licencia; lo que se retiró fue una promesa que el README hacía sin poder cumplir.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 819397c7f59e · soveria-ai/audits/veredictos-20260905/ -->

## D-21 · 2026-08-13 — El aislamiento del render Vega: se cierra la E/S, NO se construye el subproceso

- **Bifurcación**: el roadmap pide «aislamiento del render Vega en **subproceso sin red ni filesystem**». ¿Se construye el subproceso, o se ataca el vector por otra vía?
- **La medición que decidió** (2026-08-13, en esta máquina, Node v22.22.3 — el mismo mayor que corre en la imagen, `node:22-slim`): el **permission model de Node 22 NO cubre la red**. Con `--experimental-permission --allow-fs-read=<dir>`: lectura fuera de la lista `ERR_ACCESS_DENIED` ✓, `child_process` `ERR_ACCESS_DENIED` ✓, y **`net.connect` a un host externo CONECTÓ**. O sea el subproceso entregaría *la mitad* del enunciado, y a cambio mete un pool de procesos en el camino caliente del render.
- **Corrección de instrumento, que casi produce el hallazgo contrario**: las primeras corridas fallaban al arrancar incluso con `node -e`, y parecía que el permission model rompía todo. Era el `NODE_OPTIONS` de esta terminal inyectando un `--require`. Con `env -u NODE_OPTIONS` el modelo funciona. **El instrumento medía el entorno, no el fenómeno.**
- **Decidido**: cerrar el vector **donde está**, en dos capas dentro del proceso, y no construir el subproceso. El vector real es que Vega sabe cargar datos sola (`data.url`, por red o `file://`) y los specs de Vergis traen los datos ya resueltos: ese camino no debe usarse nunca. (1) **Gate declarativo** — un spec con `url` se rechaza antes de llegar a Vega, ruidosamente. (2) **Loader que niega** toda E/S, como red de seguridad.
- **Por qué DOS capas y no solo el loader — medido, no supuesto**: con un servidor HTTP local contando hits, el loader por defecto **hace el fetch** (`hits=1`); el loader que niega lo evita (`hits=0`) **pero Vega se traga el error y rinde un gráfico vacío**, sin excepción. Protección silenciosa = PI degradado en silencio, que esta plataforma trata como defecto en todas las demás capas.
- **Lo que queda sin cubrir, dicho**: un exploit de Vega que haga E/S **sin pasar por su loader** (p. ej. por una dependencia transitiva) no lo detiene ninguna de las dos capas. Esa es la parte que un subproceso sí cubriría, y el día que exista un driver, la fs se cierra con el permission model y **la red hay que cerrarla en la red del contenedor**, no en Node. Queda escrito en el roadmap.
- **Costo de revertir**: bajo — dos piezas locales en `render-chart.ts`; quitarlas restaura el comportamiento anterior. El subproceso sigue disponible como camino, ahora con su medición hecha.
<!-- segundo-ojo · Correcta con salvedad medible: Node 26 --permission sí niega la red · 2026-09-05 · juez Fable 5.1 · sha12 70cab2bcfed8 · soveria-ai/audits/veredictos-20260905/ -->

## D-20 · 2026-08-13 — El diagnóstico de #165 NO esconde el PI: lo explica

- **Bifurcación**: `canAccess` deja ver un PI si el sujeto trae **algún** valor del claim. Con `op: eq` y un claim de dos valores, la política niega **todas** las filas: el PI aparece en el índice y se abre vacío. ¿Se corrige la visibilidad (esconderlo, que es la dirección fail-closed) o se deja como está y se agrega el diagnóstico?
- **Decidido**: **la visibilidad no se toca; se agrega la explicación**. Esconderlo cambia una falla muda por otra —el sujeto pasa de «lo abro y está vacío» a «ya no está», igual de indistinguible de «no tengo permiso»— y encima destruye la única pista que tenía el operador. El issue pide explícitamente que el fail-closed no se toque; lo que faltaba no era ocultar mejor sino **poder decir cuál de las tres cosas pasó**.
- **Dónde vive, y por qué importa**: en `packages/policy/src/diagnose.ts`, junto al evaluador de referencia, **no** en el server. La explicación de una negación es semántica del IR: en el canal de serving cada back-end tendría su propia versión de «por qué no ves nada» y divergirían en la primera corrección. Además es función de `(policy, claims)` sin tocar filas — así vale igual en push-down, donde las filas no pasan por este proceso.
- **Lo que lo hace afirmable**: `deniesAllRows` se prueba como **teorema** contra el oráculo (2000 casos: si dice que niega todo, `applyPolicy` devuelve `[]`), con un **control de que las dos ramas se ejercitaron** (≥100 de cada lado) — sin él, una función que devolviera siempre `false` habría «pasado» el teorema sin ser puesta en riesgo jamás.
- **Costo de revertir**: bajo y aislado — el módulo es aditivo y nadie depende de él para decidir; quitar la llamada en `indexReports` apaga la línea del log sin tocar enforcement.
<!-- segundo-ojo · Correcta con salvedad medible: la llamada vive en discovery.ts, no en indexReports · 2026-09-05 · juez Fable 5.1 · sha12 48a2aba630d0 · soveria-ai/audits/veredictos-20260905/ -->

## D-19 · 2026-08-10 — La marca queda sin tocar (gasto), y se dice qué falta

> **SUPERADA 2026-08-13 por decisión de César: no se registra nada.** Esta entrada dejó la marca
> en su mesa; él la bajó de la mesa. La decisión de fondo queda cerrada en `TODO.md`; esto se
> conserva porque registra *por qué* el agente no la tomó — el límite del mandato, que sigue vigente.

- **Bifurcación**: la marca «Vergis» (y «Custos»/«Miranda») sigue diferida por César desde el 2026-08-08, con estado registral sin verificar. Con mandato amplio: ¿levantar el memo de disponibilidad, iniciar algo, o dejarlo?
- **Decidido**: **no se ejecuta nada**, y no por criterio sino por autoridad — registrar una marca **gasta plata** y compromete a Gegolabs frente a un registro público. Es de la familia que el mandato explícitamente no cubre. Tampoco se levanta el memo de disponibilidad: su valor entero está en consultar INAPI (y equivalentes) con datos reales, y una búsqueda no autoritativa presentada como memo sería justo el tipo de artefacto que la Norma 6 prohíbe — una conjetura con cara de dato que decide por quien la lea.
- **Lo que sí queda dicho**: el riesgo es asimétrico y no cambió. El registro temprano es barato; la ausencia es **irreversible** si otro registra primero. Sigue en `TODO.md` como decisión suya.
- **Costo de revertir**: nulo — no se hizo nada.
<!-- segundo-ojo · Superada por decisión de César (2026-08-13), sin D-NN · 2026-09-05 · juez Fable 5.1 · sha12 49ed1362180f · soveria-ai/audits/veredictos-20260905/ -->

## D-18 · 2026-08-10 — El borrador de `CONTRIBUTING.md` se redacta, pero se deja INACTIVO

- **Bifurcación**: el diseño `004/11` §D5 (aprobada) manda redactar `CONTRIBUTING.md` con DCO + cláusula de relicencia marcada como sujeta a revisión legal; `TODO.md` prohíbe publicarlo sin revisión de César o de un abogado. ¿Se escribe como `CONTRIBUTING.md` confiando en el marcador HTML, o de otro modo?
- **Decidido**: se escribe como **`CONTRIBUTING.draft.md`**. Un comentario HTML no detiene nada: GitHub muestra `CONTRIBUTING.md` a todo el que abre un issue o un PR, y en ese instante la cláusula empieza a **obligar a terceros** — que es exactamente lo que la revisión pendiente debe autorizar. Con el nombre en `.draft.md` el trabajo queda hecho y el acto de publicar se reduce a un `git mv`, que es de César.
- **Contenido**: DCO 1.1 por `Signed-off-by`, cláusula de licencia de contribución con **su porqué dicho de frente** (por qué un DCO a secas no basta para el dual licensing, y que no se pide cesión de copyright), gates del CI, presupuesto de dependencias cero en `botler`/`policy`, y canal privado de seguridad. Dos huecos marcados en el texto: la redacción legal exacta y la dirección de contacto (sin confirmar).
- **Costo de revertir**: nulo — borrar un archivo que no está activo.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 3514b4b14874 · soveria-ai/audits/veredictos-20260905/ -->

## D-17 · 2026-08-10 — #111 (rúbrica de convenciones) NO se cabla: espera su disparador

- **Bifurcación**: el H1 (sembrar el catálogo en `rubric/`) ya está mergeado (#147). ¿Se cabla el H2 —montar `convenciones.md` en el prompt de Miranda— ahora que hay mandato, o se respeta el disparador «≥2 casos aplicados» que el propio diseño declaró?
- **Decidido**: **se respeta el disparador**. Cablear ahora sería construir contra un catálogo de 4 convenciones sin uso medido — exactamente el «folclore» que el diseño combatió al volver el disparador medible (`grep -c` sobre las líneas `- caso …` del ledger). El mandato delega el juicio operativo; no convierte en atendible lo que está diferido por su propia condición.
- **Costo de revertir**: nulo — cablear sigue siendo el camino previsto el día que el ledger llegue a 2 casos.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 c42db6b5c726 · soveria-ai/audits/veredictos-20260905/ -->

## D-16 · 2026-08-10 — #138 se cierra con mandato de César

- **Bifurcación**: las tres piezas de #138 están atendidas (la 1 subsumida por #139·N1, la 3 medida y corregida en #140, la 2 implementada en #151). El issue quedaba «pagado, esperando finiquito». ¿Cerrarlo o dejarlo a César?
- **Decidido**: **cerrarlo**, con mandato explícito de César en esta sesión. La regla dura «el issue jamás se cierra solo» protege al **tercero** que lo abrió; acá el autor es el principal y él delegó la firma. Se cierra con comentario que deja el rastro de por qué cada pieza está saldada y qué queda diferido con disparador (fases 2-3 de config recargable).
- **Costo de revertir**: nulo — reabrir un issue es un clic.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 55696d740b03 · soveria-ai/audits/veredictos-20260905/ -->

## D-15 · 2026-08-10 — Se corta 0.15.0 (CHANGELOG + version + tag)

- **Bifurcación**: 21 PRs (#140-#160) sin entrada ni tag desde el deploy 0.14.0. El corte de versión venía marcado como decisión de César (precedente D-05). Con mandato: ¿0.15.0, o 1.0.0 dado el peso del tren?
- **Decidido**: **0.15.0**. La convención declarada en el propio CHANGELOG es explícita — «Y sube con cada conjunto de capacidades nuevas del DSL/runtime; **X se reserva para el primer release estable**». Nada en este tren declara estabilidad de contrato; el fix de #142 apunta en contra (la superficie de Miranda todavía estaba encontrando huecos de autorización).
- **Costo de revertir**: bajo — el tag se re-corta; nada desplegado hasta el paso siguiente.
<!-- segundo-ojo · Correcta con salvedad medible: son 20 PRs mergeados, #159 no es PR · 2026-09-05 · juez Fable 5.1 · sha12 1fc1a25f6586 · soveria-ai/audits/veredictos-20260905/ -->

## D-14 · 2026-08-10 — La baja del port a Go de `TODO.md` (y el delta que la funda)

- **Bifurcación**: César pidió detalle para evaluar si dar de baja el port del kernel a Go. ¿Se descarta el port, se deja el pendiente, o se hace otra cosa?
- **Decidido** (mandato explícito de César, «baja el port a Go»): **no se descarta el port — se retira el duplicado**. La decisión ya vivía en ADR-001 §Decisión·2; la línea de `TODO.md` la repetía con menos matiz y **había quedado falsa**: ADR-002 catalogó `packages/policy` como pieza abierta prioridad 1, con lo que «Custos como producto standalone» dejó de ser driver de ingreso. El ADR gana un delta con el reencuadre, los disparadores vivos (embedding, librería/WASM — ninguno con demanda) y la contra-consideración del Motor L (#113·09), etiquetada como leída-no-medida.
- **Colateral**: la cifra «2.100 iteraciones de property testing» del ADR-001 **no se reproduce** — lo medido es 800+800 = 1.600 (2.400 aserciones). Corregida con nota visible. La conclusión del ADR no se cae; la cifra era carga y estaba mal.
- **Informe**: `work/007-informe-port-go-2026-08-10/01-informe-baja-port-go-v1.0.md` (+ PDF en `export/`).
- **Costo de revertir**: nulo — reponer una línea en `TODO.md`. El port sigue disponible con sus disparadores sellados.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 502335b8dc20 · soveria-ai/audits/veredictos-20260905/ -->

## D-13 · 2026-08-10 — Se bendice el import directo a módulos-hoja de `@vergis/capabilities`

- **Bifurcación**: pendiente abierto desde el 07 (`VERGIS_VERSION` importado por ruta relativa en `server/contract.ts`): ¿re-exportar en el índice del package, o bendecir el import directo a módulos-hoja?
- **Decidido**: **bendecir el import directo**, con dos requisitos — el módulo-hoja no tiene imports propios, y el import lleva su porqué escrito al lado. Lo que inclinó la balanza: este mismo lote produjo un segundo caso con la razón idéntica (`server/pdf.ts` → `table-runtime`), y la razón es dura, no de gusto: entrar por el índice arrastra vega/mssql a tests de módulos que son puros por contrato. Dos casos con la misma causa dejan de ser excepción.
- **Costo de revertir**: bajo — añadir los re-exports al índice y cambiar 2 líneas de import.
<!-- segundo-ojo · Correcta con salvedad medible: contract.ts importa la hoja sin el porqué al lado · 2026-09-05 · juez Fable 5.1 · sha12 412157674c46 · soveria-ai/audits/veredictos-20260905/ -->

## D-12 · 2026-08-10 — Versiones de GitHub Actions elegidas aplicando el cooldown del propio proyecto

- **Bifurcación**: el pendiente decía «subir `checkout`/`setup-node` a v5». Al medir, la vigente es **v7** y hay una v46.2.2 recién salida del action de Renovate. ¿Se sigue la letra del pendiente, se toma lo último, o se aplica el criterio del proyecto?
- **Decidido**: **aplicar el `minimumReleaseAge` de 14 días del propio `renovate.json`** como criterio de selección. `checkout@v7` (publicada 07-20) y `setup-node@v7` (07-14) lo cumplen; para el action de Renovate se eligió **v46.1.21** (07-27) descartando v46.2.2/v46.2.1/v46.2.0 por tener 1/8/13 días. El arnés que hace cumplir el cooldown no se salta el cooldown.
- **No tocadas a mano**: las `docker/*` del build — las propondrá Renovate con su changelog, que es exactamente para lo que se encendió.
- **Costo de revertir**: bajo — son líneas de `uses:`; el CI valida el cambio en el mismo push.
<!-- segundo-ojo · Correcta con salvedad medible: edades de releases corridas un día; conclusión intacta · 2026-09-05 · juez Fable 5.1 · sha12 5dd746eab3fc · soveria-ai/audits/veredictos-20260905/ -->

## D-11 · 2026-08-10 — Renovate corre SELF-HOSTED en el CI, no como GitHub App

- **Bifurcación**: `renovate.json` existe desde el 2026-06-11 pero es **inerte** sin la App instalada, e instalarla exige consentimiento OAuth del owner de la org (acción humana no automatizable). Opciones: (a) Renovate self-hosted por GitHub Actions, (b) migrar a Dependabot nativo, (c) seguir esperando la instalación, (d) nada.
- **Decidido** (César eligió A al presentarle las cuatro): **(a) self-hosted** — `.github/workflows/renovate.yml`, semanal + `workflow_dispatch`. Conserva el `renovate.json` **tal cual**, sin traducir nada: el cooldown de 14 días, `osvVulnerabilityAlerts` y el pinning por digest siguen siendo los ya razonados. Dependabot habría exigido reescribir la config y su pinning de Actions es más limitado.
- **Sub-decisión — fail-closed**: sin el secret `RENOVATE_TOKEN` el workflow **falla en rojo** en vez de saltarse el trabajo. Misma doctrina que #117: un control que no corre tiene que distinguirse de un control que corrió y no encontró nada. Un scheduled run rojo ES la señal de que el cooldown no está activo.
- **También**: `RENOVATE_REQUIRE_CONFIG=required` — sin config en el repo, aborta; los defaults de Renovate **no** traen el cooldown, que es su razón de ser acá.
- **Hand-off**: crear el PAT y guardarlo como secret. Es lo único que queda, y es de César.
- **Costo de revertir**: nulo — borrar un archivo de workflow.
<!-- segundo-ojo · Correcta · 2026-09-05 · juez Fable 5.1 · sha12 cec082f81abb · soveria-ai/audits/veredictos-20260905/ -->

## D-10 · 2026-08-08 — Deltas de arquitectura del plan 006 sobre el diseño de la fase 2 de #107

- **Bifurcación**: el hallazgo del hito cero (el motor normaliza el payload: `""→null`, re-serialización) obliga a canonicalizar antes de comparar (refinamiento de D7, sellado en #107). ¿Dónde vive la canonicalización y cómo se reparte sin romper el paralelismo de la Ola 1 (H1∥H2∥H3)?
- **Decidido** (Δ1-Δ5 del plan `work/006-cluster-107-f2-publicacion/00-plan-v1.0.md`): (Δ1) módulo `definition-canonical.ts` en territorio H2; el sha del render, del ledger y del read-back es UNO, el canónico; lo no medido (payloads no-JSON) NO se normaliza — queda byte-a-byte con conjetura etiquetada. (Δ2) `derivePublishPlan` puro sobre shas — quien canonicaliza es el flujo admin (H4); evita dependencias H3→H1/H2 dentro de la ola. (Δ3) tipos por tipado estructural, sin imports cruzados en la Ola 1. (Δ4) `index.ts` único cruce declarado; lo resuelve el orquestador. (Δ5) `VERGIS_JOB_TEMPLATES` nace solo-arranque, FUERA de `RELOADABLE_SLICES` — la recargabilidad es de las fases 2-3 de #138·2, que esperan a César.
- **Costo de revertir**: bajo — Δ1/Δ2/Δ3 son cortes de módulo (mover una función es un refactor local); Δ5 es agregar una entrada a la tabla de slices cuando César apruebe las fases siguientes.
<!-- segundo-ojo · Correcta: definition-canonical.ts, derivePublishPlan puro, VERGIS_JOB_TEMPLATES fuera de RELOADABLE_SLICES · 2026-09-05 · juez Fable 5.1 · sha12 06f8d48dff5d · soveria-ai/audits/veredictos-20260905/ -->

## D-09 · 2026-08-08 — Correr la sonda del hito cero de #107 contra el tenant real (plantación)

- **Bifurcación**: el hito cero de #107 F2 exige un experimento que ESCRIBE en el tenant (crea y borra un item). ¿Correrlo contra workspace real o sandbox, y con qué credencial?
- **Decidido** (César, go operativo en sesión): workspace **real** de plantación (`1d331022…`, D12), credencial del SP del intake (D9 default), corrida DENTRO del contenedor de la VM para no extraer el secreto a local (Norma 5). Ejecutada dos veces (reproducible), cero residuo.
- **Resultado**: **el SP puede autorar** (crear 201, agendar 201, borrar 200; controles A/A2 verdes). El exit 6 fue normalización del motor (`""→null` + pretty-print), no falta de persistencia — caracterizado. Refinamiento revelado para D7 (comparar canonicalizado, no por bytes). Sellado en #107.
- **Costo de revertir**: nulo — fue una medición idempotente (crea+borra); no dejó estado en el tenant.
<!-- segundo-ojo · Correcta con salvedad medible: escribe tenant (SÍ, go de César); residuo no re-medible · 2026-09-05 · juez Fable 5.1 · sha12 5d5dbcc57e84 · soveria-ai/audits/veredictos-20260905/ -->

## D-08 · 2026-08-08 — Semántica del guard de pertenencia de Miranda (frente F1 del cluster 005)

- **Bifurcación**: al diseñar el fix de las 5 rutas sin check de dueño: (a) ¿403 honesto o 404 que oculta la existencia?; (b) ¿qué pasa con sesiones legadas sin `created_by`?; (c) ¿el gate de publish va en el handler o dentro de `publishSpec`?
- **Decidido**: (a) **403** — los ids son UUIDv4, la enumeración es impracticable y el error honesto es el patrón del producto; (b) **solo-admin (fail-closed)** — una sesión sin dueño demostrable no se abre al scope, la rescata un admin; (c) **en el handler** — la identidad vive en la frontera HTTP y `publishSpec` conserva su contrato puro de gates de estado. Además se sella intocable el invariante de 004/02: la autorización de tools sigue atada al requester, no al dueño. Diseño completo: `work/005-…/01-diseno-pertenencia-sesiones-miranda-v1.0.md`.
- **Costo de revertir**: bajo — (a) cambiar el código de respuesta es una línea; (b) relajar el caso NULL es quitar una condición; (c) mover el gate al paquete es aditivo.
<!-- segundo-ojo · Correcta: miranda.ts:343-353 (404/403, NULL owner → solo admin); PR #142 · 2026-09-05 · juez Fable 5.1 · sha12 04975670703d · soveria-ai/audits/veredictos-20260905/ -->

## D-07 · 2026-08-07 — `/contrato` solo para admins, y la pieza 2 de #138 no se implementa sin revisión

- **Bifurcación**: (a) ¿quién puede leer el contrato operativo de #139 — cualquier identidad autenticada tras el proxy, o solo admins?; (b) ¿se implementa de una vez la pieza 2 de #138 (env → archivo recargable) o se somete el diseño primero?
- **Decidido**: (a) solo admins (gate de token + `isAdmin` del store de gobierno; sin governance → 403): el payload expone rutas del contenedor y nombres de env — superficie de operación, no de consumo. (b) La pieza 2 queda en diseño (`work/003-…/03-…`) esperando a César: cambia el contrato de despliegue de las instancias (qué viaja en env vs en archivo) y arrastra semánticas de re-siembra vs gestión in-app.
- **Costo de revertir**: (a) bajo — relajar el gate es quitar una condición; (b) nulo — implementar después es el camino previsto.
<!-- segundo-ojo · Correcta: (a) contract.ts:370/381 medido; (b) absorbida por D-16 · 2026-09-05 · juez Fable 5.1 · sha12 d515b54ec67a · soveria-ai/audits/veredictos-20260905/ -->

## D-01 · 2026-08-06 — Orden y paralelización del backlog en 4 olas por territorio

- **Bifurcación**: atender 15 issues — ¿secuencial puro, o paralelo por territorio?
- **Decidido**: 4 olas (A: #99/#61/#117/#66 · B: #101/#114/#62/#108 · C: #105/#63/#109/#65 · D: #100/#102/#107), paralelizando frentes de territorio disjunto e integrando secuencialmente con gates. Dependencias: #101←#99, #63←#62, #102←{#99,#101,#100}.
- **Racional**: minimiza colisiones de archivos entre frentes y respeta las dependencias declaradas en los propios issues; los de demanda dura de usuario (#61, #99) van primero.
- **Costo de revertir**: nulo — es orden de trabajo, no forma del producto.
<!-- segundo-ojo · Correcta con salvedad medible: dependencias respetadas; el orden no siguió las olas; 16 frentes, no 15 · 2026-09-05 · juez Fable 5.1 · sha12 1fb5d09832d8 · soveria-ai/audits/veredictos-20260905/ -->

## D-02 · 2026-08-06 — #106 (docs) queda al final, condicional al tren

- **Bifurcación**: ¿incluir #106 (documentación multi-reporte + gobierno) en el alcance «todo lo accionable»?
- **Decidido**: se atiende solo si las olas A–D cierran; los issues de código tienen demanda de usuario y el doc no bloquea a nadie hoy.
- **Costo de revertir**: nulo.
<!-- segundo-ojo · Correcta: #106 mergeado el mismo día tras cerrar las olas (e7372ce) · 2026-09-05 · juez Fable 5.1 · sha12 d92d76ebe62f · soveria-ai/audits/veredictos-20260905/ -->

## D-06 · 2026-08-06 — Encender vm-vergis-qa para el ensayo del deploy 0.14.0

- **Bifurcación**: la VM de QA estaba deallocated; ¿ensayar (encenderla) o saltar el ensayo?
- **Decidido**: encenderla — el ensayo en QA antes de PROD es el camino documentado (BITACORA 2026-07-13) y César autorizó «avanzar con el deploy», que lo incluye. Se deja apagada (deallocated) al terminar, como estaba.
- **Costo de revertir**: `az vm deallocate` (minutos de cómputo del ensayo).
<!-- segundo-ojo · Correcta: gasto SÍ con go de César; VM hoy deallocated (az) · 2026-09-05 · juez Fable 5.1 · sha12 a860cc4c15cf · soveria-ai/audits/veredictos-20260905/ -->

## D-05 · 2026-08-06 — Se corta el release 0.14.0 en el repo (CHANGELOG + version + tag), sin deploy

- **Bifurcación**: dejar los 15 merges sin versión, o cortar 0.14.0 repo-side siguiendo la convención del CHANGELOG (Y sube con cada conjunto de capacidades).
- **Decidido**: version bump + entrada de CHANGELOG + tag `v0.14.0`. El DEPLOY a la VM queda como hand-off (producción gated; además #117 exige verificar los YAML de instancia antes de subir).
- **Costo de revertir**: bajo — el tag se puede re-cortar; nada desplegado.
<!-- segundo-ojo · Correcta: tag v0.14.0 = 1f963dc; deploy separado y autorizado (b438c21) · 2026-09-05 · juez Fable 5.1 · sha12 f3596c0e583b · soveria-ai/audits/veredictos-20260905/ -->

## D-04 · 2026-08-06 — notify.yaml sin clave raíz LANZA (override del contrato sellado de #100)

- **Bifurcación**: el diseño de #100 selló `parseNotifyConfig({}) ⇒ cero destinos en silencio`; #117 (mergeado después de ese diseño) estableció que la clave raíz ausente en un YAML declarado es archivo roto y tumba el arranque. El implementador reportó la tensión sin resolverla.
- **Decidido**: consistencia con #117 — `requireRootKey('destinations')`; el cero legítimo es `destinations: []`. Racional: un notify.yaml decapitado desactivaría en silencio el sistema que avisa fallos — exactamente la evaporación que #117 cierra, en el peor lugar posible.
- **Costo de revertir**: una línea + un test (commit del ajuste en PR #129).
<!-- segundo-ojo · Correcta: notify.ts:129 requireRootKey + test 28-30 en 609c4f1 (PR #129) · 2026-09-05 · juez Fable 5.1 · sha12 cb33731ac012 · soveria-ai/audits/veredictos-20260905/ -->

## D-03 · 2026-08-06 — Emails de avance: cuenta claude → cesar.obach@ultrabase.net

- **Bifurcación**: César pidió informes por email al cierre de tickets/olas; ¿a qué dirección?
- **Decidido**: desde la cuenta claude (claude.amodei@gmail.com) hacia `cesar.obach@ultrabase.net`, per skill `ww:wingworking-email-sending` (tema ultraBASE/producto; «si hay duda, ultrabase.net»).
- **Costo de revertir**: nulo — se redirige el siguiente envío.
<!-- segundo-ojo · Correcta: skill L89/L96; envíos registrados; regla de cuenta evolucionó después · 2026-09-05 · juez Fable 5.1 · sha12 34430a44e0af · soveria-ai/audits/veredictos-20260905/ -->
