# Banco V-14 — corridas y lo que midieron

> Registro de lo **medido**, no de lo concluido. Cada fila nombra el archivo crudo del que salió su cifra; nada acá se afirma sin ese archivo detrás. Los crudos viven en `.run/datos/` y **no se versionan**: son dato de corrida, no fuente.

## 2026-08-26 · corrida de construcción y controles negativos

**Mundo:** worktree `vergis-wt-bench-v14`, rama `feat/225-bench-v14`, imagen construida desde ese árbol (`origin/main` a `1cad2d0`) y etiquetada `benchv14/vergis:9.9.1` y `:9.9.2` — **mismo contenido a propósito**: el sujeto es el ACTO, no el delta entre versiones. Motor `clickhouse` con dataset sembrado. **9 PIs servidos, 9 de 9** (`.run/datos/pis-servidos.json`).

### CN-1 · control negativo DEL INSTRUMENTO

Poller apuntado **directo** a un nodo en espera.

| Corrida | Muestras en ventana | OK | MAL | SINMEDIR | Familia del MAL |
|--|--|--|--|--|--|
| r1 (20 s) | 662 | **0** | **662** | 0 | `200 ∧ phase=standby`, 662 de 662 |
| r2 (12 s, instrumento corregido) | 390 | **0** | **390** | 0 | `200 ∧ phase=standby`, 390 de 390 |

**Veredicto: CN-1 PASA.** El instrumento ve el fallo que tiene que ver, y no lo confunde con no-poder-medir. Cadencia observada ≈ 34 muestras/s (el objetivo era ~28 ms entre despachos). El contraste positivo lo aporta la misma corrida CN-2, donde el mismo instrumento sí emite `OK` contra el conmutador.

### CN-2 · control negativo DEL MECANISMO (promoción con el orden VIGENTE: handover → flip)

| Corrida | Sentido | En ventana | OK | MAL | SINMEDIR | Tramo (a) `200 ∧ standby` | Ventana del tramo (a) | 503 de sala de espera |
|--|--|--|--|--|--|--|--|--|
| r1 | 9.9.1 → 9.9.2 | 103 | 45 | 58 | 0 | **18** | +1.319 ms → +1.816 ms (497 ms) | 40, latencia máx 1.487 ms |
| r2 | 9.9.2 → 9.9.1 | 104 | 35 | 69 | 0 | **9** | +1.017 ms → +1.251 ms (234 ms) | 60, latencia máx 2.035 ms |
| r3 | 9.9.1 → 9.9.2 | 102 | 48 | 54 | 0 | **27** | +1.406 ms → +2.168 ms (762 ms) | 27, latencia máx 1.241 ms |

**Veredicto: CN-2 REPRODUCE el tramo (a)**, las tres veces, en los dos sentidos. La duración del tramo varía entre 234 y 762 ms y el conteo entre 9 y 27 respuestas: **la dispersión no está explicada y no se persigue** — lo que el control negativo tenía que demostrar es que el fenómeno se produce y el instrumento lo ve, no cuánto dura. Cero `SINMEDIR`: no hay tramo del acto en que el banco no haya podido medir.

**Tramos internos de r2** (leídos de los logs con timestamp de ambos nodos y del borde; el acto arrancó en `t0`):

| Evento | Cuándo | Fuente |
|--|--|--|
| `SIGUSR2` → el viejo suelta el control y queda en standby | +1.014 ms | log del nodo viejo |
| primera respuesta `200 ∧ standby` entregada por el borde | +1.017 ms | crudo del poller |
| última respuesta `200 ∧ standby` | +1.251 ms | crudo del poller |
| el candidato adquiere el control (relevo) | +2.128 ms | log del candidato |
| relevo completo, lazos armados | +2.137 ms | log del candidato |
| `caddy reload` del flip del borde | +3.288 ms | log del borde |

El tramo (a) **empieza con el release** y **termina ~237 ms después**, no con el flip: lo cierra el health check del borde al enterarse de la transición. Entre ese cierre y el flip, el borde no tiene upstream sano y retiene.

**Observación sobre los 503, sin veredicto de causa.** En las dos corridas, **todas** las respuestas 503 de la sala de espera se cerraron **después** del `caddy reload`, y muy cerca de él: `t1 − t_reload` cayó entre **+19 y +95 ms** (r2, n=70), **+38 y +82 ms** (r1, n=49) y **+29 y +64 ms** (r3, n=40), con latencias individuales escalonadas de 354 a 2.035 ms — o sea, requests despachados en instantes distintos que **terminan todos en el mismo instante de pared**. Es una correlación fuerte y se registra como tal. **La causa NO se declara acá**: discriminarla es el trabajo de V-15 con sus tres brazos y su propio control negativo, y afirmarla desde una sola correlación es exactamente lo que la Norma 7 prohíbe.

### Loop de mutaciones (1/s, `POST /<pi>/imprimir` por el conmutador)

| Corrida | Total | Ejecutadas (200 + id) | `409` explícitos | Fallos | `sinmedir` | Latencia máx | Cero-pérdidas |
|--|--|--|--|--|--|--|--|
| r1 | 23 | 21 | 1 | 1 (503 de la sala de espera) | 0 | 489 ms | 20 de 20 ids verificados vivos, 0 perdidos |
| r2 | 23 | 20 | 1 | 2 (503 de la sala de espera) | 0 | 1.183 ms | 20 de 20 ids verificados vivos, 0 perdidos |
| r3 | 23 | 21 | 1 | 1 (503 de la sala de espera) | 0 | 760 ms | 20 de 20 ids verificados vivos, 0 perdidos |

Ni un solo **500** y ni una sola **pérdida**: cada id devuelto por una mutación ejecutada seguía existiendo después del acto, consultado contra el nodo que quedó con el control. Los fallos son del **mismo fenómeno de los 503**, no de la escritura: mutaciones capturadas en la retención.

### Hallazgo sobre el instrumento (corregido en la corrida)

La página de la sala de espera (`deploy/edge/espera.html`, montada directo desde el repo) contiene, **en un comentario**, la cadena literal `"phase":"serving"`. Un extractor por expresión regular —como el del poller canónico— le lee `phase=serving` a un **503 del borde**, y lo anota como si el nodo hubiera hablado. El predicado no se rompe (exige `200`, y el 503 nunca lo satisface), así que **no produce un falso verde**; produce algo más difícil de diagnosticar: un dato con cara de verdad en la columna `phase`, justo en el tramo bajo estudio. `poller-v14.mjs` **parsea el cuerpo como JSON** en vez de grepearlo, y un cuerpo no-JSON queda como fallo medido (`MAL`, con `noJson: true`), nunca como `SINMEDIR`. Vale la pena mirar si el poller canónico del proyecto quiere la misma corrección.

---

## 2026-08-26 · V-14 · orden flip-first

**Mundo:** worktree `vergis-wt-v14`, rama `feat/225-v14-integracion` — la implementación flip-first (`68d3600`/`78dc19f`/`b69851b`) **y** el banco (`03c677d`) en el mismo árbol. La imagen se **reconstruyó desde este worktree** (`benchv14/vergis:9.9.1` y `:9.9.2`, mismo contenido a propósito, digest `sha256:cbb70a1b…`): el orden nuevo vive en la herramienta, pero el **consumo del intent vive en el Producto**, así que medir con la imagen de la corrida anterior habría medido un nodo que no sabe leer `control.handover.json`. Verificado en el contenedor vivo: `/app/dist/serve-rls.mjs` contiene `control.handover.json`. Motor `clickhouse`, **9 PIs servidos, 9 de 9**.

**Borde:** `health_interval` **250 ms**, espejado de `deploy/Caddyfile.reference` y verificado **contra el sujeto** (admin API `:2019` → `"interval":250000000`), no contra el archivo.

### Controles negativos en este mundo

**CN-1 (instrumento), re-corrido tras el rebuild:** 12 s, **395 muestras · 0 OK · 395 MAL · 0 SINMEDIR**, familia `200 ∧ phase=standby` 395 de 395. **PASA.** El instrumento sigue viendo el fallo que tiene que ver en el mundo nuevo.

**CN-2 (mecanismo):** no se repite acá — es la sección anterior de este mismo archivo, corrida con el orden **vigente** y su mismo instrumento. Es el contraste contra el que se leen las filas de abajo.

### V-14 · el acto bajo el orden nuevo (flip → handover dirigido)

Criterio duro del contrato (`work/225` §7-§8): **fuera-de-predicado = 0 por corrida**. El espejo se midió **aparte**: «es el mismo código» no es una medición.

| Corrida | Acto | Sentido | En ventana | OK | MAL | SINMEDIR | **Fuera de predicado** | `200∧standby` | 503 de espera | p50 OK | p95 OK | p100 OK |
|--|--|--|--|--|--|--|--|--|--|--|--|--|
| v14-r1 | `promote` | 9.9.1 → 9.9.2 | 101 | 101 | **0** | 0 | **0** | 0 | 0 | 5 ms | 505 ms | 550 ms |
| v14-r2 | `promote` | 9.9.2 → 9.9.1 | 170 | 170 | **0** | 0 | **0** | 0 | 0 | 4 ms | 1.004 ms | 1.032 ms |
| v14-r3 | `promote` | 9.9.1 → 9.9.2 | 169 | 169 | **0** | 0 | **0** | 0 | 0 | 6 ms | 2.006 ms | 2.014 ms |
| v14-rb1 | `rollback` | 9.9.2 → 9.9.1 | 171 | 171 | **0** | 0 | **0** | 0 | 0 | 4 ms | 2.004 ms | 2.010 ms |
| v14-rb2 | `rollback` | 9.9.1 → 9.9.2 | 171 | 171 | **0** | 0 | **0** | 0 | 0 | 4 ms | 1.007 ms | 1.036 ms |
| v14-rb3 | `rollback` | 9.9.2 → 9.9.1 | 137 | 137 | **0** | 0 | **0** | 0 | 0 | 5 ms | 1.505 ms | 1.514 ms |
| carrera | 20 × `promote` | alternando | 5.047 | 5.047 | **0** | 0 | **0** | 0 | 0 | 4 ms | 1.505 ms | 2.531 ms |

Crudos: `.run/datos/v14-{r1,r2,r3,rb1,rb2,rb3}/` y `.run/datos/carrera/` (`poller.jsonl`, `mutaciones.jsonl`, `ventana.json`, `veredicto.json`, `tool.log`, `log-{viejo,candidato,borde}.txt`). **Cero `SINMEDIR` en las 7 corridas**: no hubo tramo del acto en que el banco no pudiera medir.

**Lo que estas filas dicen y lo que NO dicen.** Dicen: **0 respuestas fuera de predicado en 6 corridas de V-14 y en la carrera de 20**, con el mismo instrumento que en la sección anterior anotó 9, 18 y 27 respuestas `200 ∧ standby` bajo el orden vigente. No dicen que el tramo (a) esté eliminado: eso es una afirmación sobre el mecanismo, la declara el orquestador con esta evidencia, y ningún texto de este banco la escribe como hecho.

**La latencia añadida es RETENCIÓN, no error.** Los requests que el borde retiene (`ms > 200`) fueron **17, 26, 57, 59, 34 y 42** en las seis corridas, y **todos terminaron `OK`** — ni un 503, ni un `standby`. El p100 se reparte en escalones de ~500 ms porque `lb_try_interval` es 500 ms: un retenido que se pierde un tick espera el siguiente.

### Tramos internos (leídos de los logs con timestamp de ambos nodos y del borde)

Origen `t=0` = el instante en que el borde recibe el `POST /load` del flip (log del borde). Una promoción y su espejo:

| Evento | v14-r2 (`promote` 9.9.2→9.9.1) | v14-rb2 (`rollback` 9.9.1→9.9.2) | Fuente |
|--|--|--|--|
| el candidato ve el intent y aspira (**relevo DIRIGIDO**) | −59 ms | −37 ms | log del candidato |
| **flip del borde** (`caddy reload`) | 0 ms | 0 ms | log del borde |
| `SIGUSR2` → el viejo suelta el control y queda standby | +108 ms | +78 ms | log del viejo |
| el viejo **se abstiene** («el intent nombra a otro») | +1.412 ms | +213 ms | log del viejo |
| el candidato **adquiere** el control | +747 ms | +781 ms | log del candidato |
| relevo completo · lazos armados (`serving`) | +763 ms | +798 ms | log del candidato |
| **el borde entrega el predicado** · suelta a los retenidos | +789 ms | +1.027 ms | crudo del poller |
| último retenido liberado | +1.285 ms | +1.496 ms | crudo del poller |

Las seis corridas, mismo formato: adquisición del control entre **+369 y +1.745 ms** del flip; el borde entrega entre **+525 y +1.784 ms**; último retenido entre **+988 y +2.264 ms**. **El intent se ve ANTES del flip en las seis** (entre −37 y −321 ms): el watch dispara con la escritura del archivo, que es el paso 2 del orden nuevo.

### La carrera del lease · 20 promociones seguidas

| Métrica | Valor | Cómo se obtuvo |
|--|--|--|
| Promociones ejecutadas | **20 de 20**, todas `rc=0` | `tool-1..20.log`, cada uno con su `✓ … es el anillo ACTIVO` |
| `warn` de `insistir_handover` («el control lo tomó otro») | **0** | `grep -c` sobre los 20 logs, contado — no asumido (`warns-por-corrida.txt`) |
| Fuera de predicado agregado | **0** de 5.047 muestras | `carrera/veredicto.json` |
| Mutaciones | 148 ejecutadas · 0 `409` · 0 fallos · 0 `sinmedir` | `carrera/mutaciones.jsonl` |
| Cero-pérdidas | **165 de 165 ids verificados vivos, 0 perdidos** | `carrera/impresiones.json` |

### Cero-pérdidas de las mutaciones (criterio: retenida-y-ejecutada o `409` explícito; un 500 o una pérdida es fallo)

| Corrida | En ventana | Ejecutadas | `409` | Fallos | `sinmedir` | Latencia máx | Verificación post-acto |
|--|--|--|--|--|--|--|--|
| v14-r1 | 4 | 4 | 0 | **0** | 0 | 609 ms | 22 de 22 vivos, 0 perdidos |
| v14-r2 | 5 | 5 | 0 | **0** | 0 | 1.118 ms | 24 de 24 vivos, 0 perdidos |
| v14-r3 | 5 | 5 | 0 | **0** | 0 | 1.611 ms | 24 de 24 vivos, 0 perdidos |
| v14-rb1 | 5 | 5 | 0 | **0** | 0 | 1.032 ms | 24 de 24 vivos, 0 perdidos |
| v14-rb2 | 5 | 5 | 0 | **0** | 0 | 545 ms | 24 de 24 vivos, 0 perdidos |
| v14-rb3 | 4 | 4 | 0 | **0** | 0 | 1.543 ms | 24 de 24 vivos, 0 perdidos |
| carrera | 148 | 148 | 0 | **0** | 0 | 2.118 ms | 165 de 165 vivos, 0 perdidos |

Ni un **500**, ni una **pérdida**, ni un `409` — bajo el orden vigente (sección anterior) hubo 1 `409` y 1–2 fallos por corrida, todos del fenómeno de los 503 de la sala de espera. Acá la mutación capturada por la retención **se ejecuta cuando el candidato ya sirve**.

### La carga del health check a 250 ms

Brazo A/B en el mismo banco, mismo instrumento, mismo mundo quieto, **sin acto**: se midió a 250 ms, se cambió el borde a 1 s (verificando el cambio contra el sujeto: `"interval":1000000000`), se volvió a medir, y se restauró el espejo a 250 ms verificando de nuevo (`"interval":250000000`). Se prefirió este A/B a comparar contra la serie CN-2 porque la p50 de aquella serie **no está en este registro** y sus crudos ya no existen: un número que no se puede releer no es una referencia.

| Brazo (40 s en reposo) | Muestras | OK | MAL | SINMEDIR | p50 | p95 | p100 |
|--|--|--|--|--|--|--|--|
| `health_interval 250ms` | 1.329 | 1.329 | 0 | 0 | **5 ms** | 13 ms | 78 ms |
| `health_interval 1s` | 1.349 | 1.349 | 0 | 0 | **5 ms** | 13 ms | 44 ms |

**Delta: 0 ms en p50 y 0 ms en p95.** El p100 difiere en 34 ms sobre una sola muestra de cola en cada brazo — un dato, no una tendencia; con n=1 por brazo no sostiene ninguna afirmación y no se persigue. Cuadruplicar el sondeo (4 req/s contra `/healthz` con un upstream declarado) **no movió la aguja** en lo que un cliente experimenta.

### Desviación: las tres primeras corridas del espejo no midieron nada

Las tres primeras `rollback` **abortaron en el pre-flight** —`/contrato` del candidato → **403**, porque la instancia del banco no tiene store de gobierno— y su veredicto salió **«0 fuera de predicado»**: cero porque **no ocurrió acto alguno**. Es exactamente el instrumento que falla hacia el verde: un aborto de pre-flight y un acto limpio producen el mismo número, y solo el `tool.log` los distingue.

**La causa, leída del código y no supuesta:** `cmd_rollback` delegaba con `cmd_promote "$target"` y **descartaba sus flags**, así que `--no-schema-gate` nunca podía llegar al camino de promoción. Se corrigió (el primer argumento sin `-` es la versión destino; el resto viaja tal cual), `lint-shell.sh` y `tests/deploy-anillos` verdes, y las tres corridas se **re-hicieron** — son las `v14-rb1..rb3` de la tabla. Los crudos del aborto quedan en `.run/datos/abortados/v14-rb{1,2,3}-preflight-403/` en vez de borrarse: un verde que no midió es evidencia, no basura.

---

## 2026-08-26 · Arnés V2–V13 · el resto del arnés de aceptación

**Qué es esto.** V1 corrió el 18-ago y V-14 el 26-ago (las dos secciones de arriba). Lo que faltaba
era el **resto del arnés de aceptación** del despliegue por anillos: los V2–V8 del dossier
(`lab/work/209` §3) y los V9–V13 del diseño (`lab/work/210` §10). Se corrió **entero, en local**,
sobre `origin/main` en `ebdf366` (flip-first y el banco ya mergeados), rama `test/210-arnes-v2-v13`.

**Mundo.** El mismo banco, extendido en un punto que resultó decisivo: los anillos ahora llevan
`VERGIS_ADMIN_SEED`. Sin bloque de gobierno la instancia **no abría `governance.sqlite`**, `/contrato`
respondía 403 y el **gate de esquema abortaba el pre-flight** — que es por lo que todo el banco venía
corriendo con `--no-schema-gate`, y por lo que V11 no se podía medir. Con el seed hay store real
(`schemaSupported 1`), el gate se ejerce de verdad y las mutaciones gobernadas tienen dónde caer.
Imagen `benchv14/vergis:9.9.1`/`:9.9.2` construida de este worktree, digest
`sha256:cbb70a1b8c29585397ad123bfce5e7c51fe9e981936ae0e8d4cc97955cadd60c`, motor `clickhouse`,
**9 PIs servidos, 9 de 9**. Todo recurso con prefijo `benchv14-`.

### El tablero

| V | Qué prueba | Veredicto | Su control negativo | Crudo |
|--|--|--|--|--|
| **V2** | El lease es exclusivo | **PASA** | La LECTURA al mismo standby responde 200 · 26.195 bytes | `.run/datos/v2/resultado.json` |
| **V3** | El standby no controla | **PASA (con alcance declarado)** | El propio instrumento vio 6 ticks en el activo en la misma ventana | `.run/datos/v3/{muestras.jsonl,veredicto.json,log-*.txt}` |
| **V4** | Cero escrituras perdidas al conmutar | **PASA** | El oráculo de H-1 (V10) sigue reproduciendo la pérdida sin fencing | `v14-{r1,r2,r3}` (26-ago) + `.run/datos/v4-conf/` |
| **V7** | Rollback sin corte ni pérdida | **PASA** | La serie CN-2 del orden vigente, con el mismo instrumento | `v14-{rb1,rb2,rb3}` (26-ago) |
| **V8** | Sin colateral | **PASA** | Invariante ausente (`Poniente`) y slug inexistente (`bench-99` → 404): los dos detectados | `.run/datos/v8/{veredicto.json,smoke.json}` |
| **V9** | Takeover ante crash | **PASA** | 628 s sin kill · 120 muestras · el standby **jamás** adquirió | `.run/datos/v9/`, `.run/datos/v9-negativo/` |
| **V10** | El fencing delata al doble escritor | **PASA** | `fencing:false` **reprodujo** la pérdida silenciosa de H-1 | `.run/datos/v10/resultado.json` |
| **V11** | Gate de esquema contra store REAL | **PASA** | `user_version` correcta → el mismo `promote` procedió (rc=0) | `.run/datos/v11/` |
| **V12** | Sala de espera | **PASA** | `lb_try_duration 1ms` → el mismo acto produjo **503** | `.run/datos/v12/` |
| **V13** | Mutaciones durante el handover | **PASA** | La serie CN-2, donde el mismo loop sí anotó `409` y fallos | `v14-*` (26-ago) + `.run/datos/{v4-conf,v8}/` |

*(V5 y V6 son de producción y quedan **gated**; V-15 también. Nada de esto tocó la VM.)*

### V2 · el lease es exclusivo

Dos nodos vivos, la **misma** mutación gobernada (`POST /bench-01/imprimir`) disparada **directo a cada
nodo**, sin pasar por el conmutador — V2 pregunta por el nodo, no por el borde. Cada disparo sale desde
el otro anillo: nadie se muta a sí mismo por `localhost`.

| Destino | Fase declarada | Respuesta |
|--|--|--|
| activo `vergis-9-9-1` | `serving` | **200** · `{"ok":true,"id":"96b50c6d-ac89-4164-af35-05e4905506b7"}` |
| standby `vergis-9-9-2` | `standby` | **409** · *«Este nodo está en espera (standby)… El nodo activo es 'vergis@b0…'»* |

**Control negativo, y no es decorativo:** un `GET` al **mismo** standby devolvió **200 · 26.195 bytes**,
byte por byte lo mismo que el activo. Sin ese brazo, un 409 de un nodo caído o incomunicado sería
indistinguible del 409 del plano de control. El 409 además **nombra al activo**, que es el contrato de
`mutacionSinControl` (`server/routes.ts`).

### V3 · el standby no controla

**326 s de observación, 22 muestras** de `/contrato` de ambos nodos cada 15 s. El criterio no es leer
código: es una **asimetría medida** de los contadores de tick.

| | `loops.armed` | Ticks EN LA VENTANA | Modo de los 3 stores | `degraded` |
|--|--|--|--|--|
| activo | `true` en las 22 muestras | `reporte-periódico` **6** · `purga-retención` 0 | `write` / `write` / `write` | `false` |
| standby | `false` en las 22 muestras | **0** en todos | `read` / `read` / `read` | `false` |

Se cuenta el **delta dentro de la ventana**, no el acumulado: un contador que ya venía de antes no
prueba que el lazo esté vivo *ahora*. Y el cero del standby solo significa algo porque el mismo
instrumento **sí vio ticks** del otro lado — ese es su control negativo.

Log de ambos nodos, con timestamp:

```
13:16:25.113 [control] lazos ARMADOS (2): purga-retención, reporte-periódico          ← activo
13:16:27.100 [control] EN ESPERA (standby): el control lo tiene 'vergis@b0ba8cd18da8/7' (época 1)
13:16:27.210 [control] lazos DESARMADOS (2 declarado(s)…) — este nodo no tiene el control.
             Ni observa, ni reconcilia, ni consume archivos, ni purga, ni reporta.
```

**Alcance declarado, y es una limitación del banco, no un resultado.** El dossier pide ver «un solo
reconciliador contra Fabric, un solo consumidor de intake». Esos dos lazos —`frescura` y
`vigilancia-de-cargas`— **no se registran** en el banco: exigen cableado Fabric
(`fabricWiring.engine` / `fabricWiring.watch`, `server/serve-rls.ts:1590` y `:1622`), y el banco corre
sobre ClickHouse. Lo medido es el **mecanismo de armado/desarmado** sobre los dos lazos que el banco sí
declara, más el modo de apertura de los stores. Que ese mecanismo sea el mismo para los cinco lazos se
lee del registro único (`loops.register` → `loops.arm()`), **no está medido para `frescura` ni para
`vigilancia-de-cargas`**, y esa parte queda para un banco con Fabric o para V5/V6 en producción.

### V4 · cero escrituras perdidas al conmutar

Ya medido en V-14 el 26-ago y **formalizado acá** citando sus crudos, más **una corrida propia de
confirmación** en este worktree:

| Corrida | En ventana | OK | Fuera de predicado | `SINMEDIR` | Mutaciones | Verificación post-acto |
|--|--|--|--|--|--|--|
| `v14-r1` (26-ago) | 101 | 101 | **0** | 0 | 4 ejecutadas · 0 `409` · 0 fallos | 22 de 22 vivos, **0 perdidos** |
| `v14-r2` (26-ago) | 170 | 170 | **0** | 0 | 5 ejecutadas · 0 `409` · 0 fallos | 24 de 24 vivos, **0 perdidos** |
| `v14-r3` (26-ago) | 169 | 169 | **0** | 0 | 5 ejecutadas · 0 `409` · 0 fallos | 24 de 24 vivos, **0 perdidos** |
| `carrera` ×20 (26-ago) | 5.047 | 5.047 | **0** | 0 | 148 ejecutadas · 0 `409` · 0 fallos | 165 de 165 vivos, **0 perdidos** |
| **`v4-conf`** (hoy, propia) | 137 | 137 | **0** | 0 | 4 ejecutadas · 0 `409` · 0 fallos | **23 de 23 vivos, 0 perdidos** |

`v4-conf`: p50 8 ms · p95 2.006 ms · p100 2.117 ms; la latencia añadida es **retención**, no error —
las 137 respuestas de la ventana satisfacen el predicado.

**El oráculo del cero-pérdidas no es la ausencia de errores**: es que cada `id` devuelto por una
mutación se **re-pregunte** después del acto, contra el nodo que quedó con el control
(`poller/verificar-impresiones.mjs`). Un 200 no prueba que el efecto sobreviviera al handover.
Y que ese oráculo sepa ver una pérdida lo demuestra **V10**, donde el mismo mecanismo de store, sin
fencing, sí pierde.

> ⚠ Los crudos `v14-*` viven en `vergis-wt-v14/deploy/rollout/bench/.run/datos/` (otro worktree) y
> `.run/` **no se versiona**: son dato de corrida. Se leyeron para escribir estas filas; no se tocaron.

### V7 · rollback sin corte ni pérdida

Mismo trato: medido en V-14, formalizado acá. El espejo se midió **aparte** de la ida, porque «es el
mismo código» no es una medición.

| Corrida | Sentido | En ventana | OK | Fuera de predicado | `SINMEDIR` | Mutaciones | Cero-pérdidas |
|--|--|--|--|--|--|--|--|
| `v14-rb1` | 9.9.2 → 9.9.1 | 171 | 171 | **0** | 0 | 5 · 0 `409` · 0 fallos | 24 de 24, **0 perdidos** |
| `v14-rb2` | 9.9.1 → 9.9.2 | 171 | 171 | **0** | 0 | 5 · 0 `409` · 0 fallos | 24 de 24, **0 perdidos** |
| `v14-rb3` | 9.9.2 → 9.9.1 | 137 | 137 | **0** | 0 | 4 · 0 `409` · 0 fallos | 24 de 24, **0 perdidos** |

Se conserva la desviación ya registrada de esa corrida —las tres primeras `rollback` **abortaron en el
pre-flight** y su cero salió de no haber medido acto alguno— porque es la que explica por qué estas
tres son re-hechas y no las originales.

### V8 · sin colateral

Una promoción medida (`9.9.1 → 9.9.2`, **69 muestras en ventana · 69 OK · 0 fuera de predicado ·
0 `SINMEDIR`**, p50 4 ms / p95 505 ms / p100 513 ms, 22 de 22 ids vivos) y **después del acto**, smoke
de los **nueve** PIs por el **borde**, con verificación de **contenido**:

| PIs | Status | Invariantes faltantes |
|--|--|--|
| `bench-01` … `bench-09` | **200** en los 9 | **ninguno** en los 9 (26.195 bytes cada uno) |

Los invariantes son el dato sembrado: las cuatro áreas (`Norte`, `Centro`, `Sur`, `Oriente`) y sus
cifras (`120`, `90`, `140`, `60`). Un 200 con la página vacía es el modo de falla «gráfico vacío, dato
correcto», y por eso el criterio no es el código HTTP.

**Controles negativos del verificador**, los dos detectados: un invariante que el dato **no** tiene
(`Poniente`) → ausente; un slug que no existe (`bench-99`) → **404**. Si esos dos salieran verdes, el
verificador no estaría leyendo el cuerpo.

Además, esta promoción corrió **con el gate de esquema puesto** —`esquema del store: candidato soporta
1 · archivo en 1 → compatible`—, que es lo que el seed de admin habilitó.

### V9 · takeover ante crash

`docker kill -s SIGKILL` al activo con el standby vivo. **`--restart unless-stopped` se retira antes
del kill y se restaura después**: con la política puesta, Docker resucita al muerto en menos de un
segundo y lo que se mediría no sería un crash sino un rebote.

**La cifra no sale del sondeo.** `ahora_ms()` del banco fabrica los milisegundos (`date +%s000`) y cada
vuelta del sondeo cuesta un `docker exec`: su «13.000 ms» tiene resolución de segundos y sesgo hacia
arriba. Los dos instantes exactos existen y no son nuestros — la **muerte** la sella Docker
(`State.FinishedAt`, nanosegundos) y la **adquisición** la sella el nodo en su propio log.

| Corrida | Muerte (Docker) | Adquisición (log del nodo) | **Δ exacto** | Época | Lazos armados |
|--|--|--|--|--|--|
| 1ª | `13:30:04.364` | `13:30:16.662` | **12.298 ms** | 4 → 5 (**+1**) | 1 → 2 (**una vez**) |
| 2ª (registrada) | `13:31:37.806` | `13:31:50.063` | **12.257 ms** | 5 → 6 (**+1**) | 2 → 3 (**una vez**) |

Lazos armados a `+12.282 ms` de la muerte; fase final `serving`.

**El techo contra el que se juzga son 14 s, no 12**, y el desglose se lee del código: `staleMs` 10.000
(`DEFAULT_STALE_MS`) + una vuelta del poller de relevo (`setInterval` de `max(500, renewMs)` = 2.000,
`serve-rls.ts:2403`) + el período de renovación que el relevo **espera antes de confirmar por
relectura** (`control-lease.ts`, `await this.#sleep(this.#renewMs)`). La primera lectura del arnés decía
12 s —la suma literal «stale + renew»— y **se corrigió antes de registrar**: se había saltado el poll y
la confirmación. Las dos corridas caen dentro del techo real con ~1,7 s de margen.

**Control negativo — lento a propósito, y no se recortó:** **628 s** de reloj de pared (120 muestras
cada 5 s) con los dos nodos vivos y **sin kill**. `held:true` en el standby: **0 de 120**. Sin este
brazo, la adquisición de arriba sería compatible con «el standby adquiere cada cierto rato de todos
modos».

### V10 · el fencing delata al doble escritor

Re-corrida de **H-1** (`work/209` §2) con la mecánica real del Producto —dos handles de
`SqliteGovernanceStore` sobre el mismo archivo, escritura alternada— contra el build de hoy. Se corre
nativo (`npx tsx deploy/rollout/bench/experimentos/v10-fencing.ts`): el sujeto es el módulo de stores,
no el contenedor.

| Brazo | Tercer volcado | En disco al final | ¿Sobrevivió el otro escritor? |
|--|--|--|--|
| **`fencing` on** (el default de la caja) | **lanzó** `SQLITE_CONCURRENT_WRITE` | `cesar@ratio.cl`, **`nuevo-admin@gh.com`**, `primero@gh.com` | **sí** |
| **`fencing` off** (control negativo) | silencioso, sin error | `cesar@ratio.cl`, `otro@gh.com`, `primero@gh.com` | **no** |

El brazo `off` es H-1 **exacto**: `nuevo-admin@gh.com` se evapora sin error, sin log y sin excepción.
Con fencing, el segundo escritor **falla ruidoso** —`el archivo vigente (ino=393088131 …) no es el que
dejó este handle (ino=393088129 …)`— y el handle queda `degraded`.

**Por qué el control negativo no es opcional acá:** si el brazo `off` no perdiera nada, el verde del
brazo `on` no diría nada del fencing — diría que el experimento no sabe producir la pérdida que
pretende prevenir.

### V11 · gate de esquema contra un store REAL

Lo que faltaba: la regla se había cubierto solo contra el arnés falso. Acá el sujeto es el
`governance.sqlite` que **comparten los anillos**.

| Paso | Observado |
|--|--|
| `user_version` del archivo antes | **1** (respaldo en `.run/datos/v11/governance.sqlite.bak`) |
| `PRAGMA user_version=99` + `docker restart` del candidato | `/contrato` del candidato declara `fileVersion: **99**` |
| `promote 9.9.2` | **rc=1** · *«pre-flight RECHAZADO: el candidato soporta esquema 1 y el archivo del store está en 99… no se tocó nada»* |
| ¿Se tocó algo? | upstream del borde **sigue en `vergis-9-9-1`**, leído del sujeto (admin `:2019`) |
| Stores degradados tras el acto | **0** |
| **Control negativo** · `user_version` restaurada a 1 + restart | `promote 9.9.2` → **rc=0**, flip, `serving`, smoke verde |

El candidato **relee** la versión porque un standby abre sus stores en **modo lectura**: expone
`fileVersion` sin aplicarse el gate, que es justo lo que permite que el pre-flight decida antes de que
nadie escriba.

### V12 · la sala de espera

`docker kill` al activo **sin standby vivo** (el otro anillo se detiene: el hueco que la sala cubre es
el de «no hay proceso»), y un request por el **conmutador** con timeout de 60 s mientras no hay a quién
rutear.

| Brazo | `lb_try_duration` **verificado contra el sujeto** | Resultado del request |
|--|--|--|
| **positivo** | `90000000000` ns | **200** · `{"ok":true,"engine":"clickhouse","phase":"serving"}` · retenido **4.070 ms** |
| **negativo** | `1000000` ns | **503** · página de la sala de espera · **580 ms** |
| restauración | `90000000000` ns | espejo intacto (`git diff` vacío) |

**La trampa histórica de este control, y cómo se evitó.** Editar el `Caddyfile` con `sed -i` cambia el
**inodo**, y el bind-mount del contenedor sigue viendo el archivo anterior: el control negativo sale
**verde-falso** y uno concluye que el mecanismo funciona cuando lo que pasó es que la config nunca
llegó. Acá el archivo se reescribe **en su mismo inodo** (truncate + write) y, sobre todo, **el valor
vigente se lee del sujeto** —admin API `:2019`— en las tres transiciones, nunca del archivo editado.
Los tres valores de la tabla salen de ahí. (`ww:wingcoding` Regla 3.)

### V13 · escritura durante el handover

El criterio: durante el acto, una mutación queda **retenida y ejecutada** (200 con id) o es rechazada
con un **`409` explícito**; un 500 o una pérdida es fallo.

| Corrida | Mutaciones en ventana | Ejecutadas | `409` | Fallos | `sinmedir` | 500 | Pérdidas |
|--|--|--|--|--|--|--|--|
| `v14-r1..r3` + `rb1..rb3` (26-ago) | 4–5 c/u | todas | 0 | **0** | 0 | **0** | **0** |
| `carrera` ×20 (26-ago) | 148 | 148 | 0 | **0** | 0 | **0** | **0** |
| `v4-conf` (hoy) | 4 | 4 | 0 | **0** | 0 | **0** | **0** |
| `v8` (hoy) | 2 | 2 | 0 | **0** | 0 | **0** | **0** |

El contraste que le da sentido está en la sección del **orden vigente** (CN-2, más arriba): ahí el
mismo loop, con el mismo instrumento, anotó 1 `409` y 1–2 fallos por corrida. El loop sabe anotar `409`
y sabe anotar fallos; que acá salgan en cero es un resultado, no una ceguera.

### Desviaciones de esta corrida

1. **El banco se cayó a mitad de V3 por una edición del propio `bench.sh` mientras corría.** `sh` lee
   el script por **desplazamiento de bytes**: editarlo en vuelo movió el offset, el shell retomó en
   medio del archivo, ejecutó `cmd_limpiar` y murió con un error de sintaxis. **V3 ya había computado y
   escrito su veredicto**, así que su medición es válida y está intacta; lo que se perdió fue el mundo,
   que se re-preparó. Regla que queda: **no se edita el orquestador mientras el orquestador corre.**
2. **El techo de V9 estaba mal leído** (12 s en vez de 14 s) y se corrigió **antes** de registrar, con
   el desglose citando el código. La medición no cambió: cambió la vara.
3. **`medir_acto` dejó de pasar `--no-schema-gate`.** Ya no hace falta —hay store real— y así cada
   acto del banco ejerce el pre-flight de verdad en vez de saltárselo.
4. **V5, V6 y V-15 no se corrieron**: son de producción y están gated. Nada de esta corrida tocó la VM,
   `/opt/mira` ni ninguna instancia.

### Teardown

`sh scripts/bench.sh limpiar` — cero `benchv14-*` vivos, cero anillos `vergis-9-9-*`, y el banco queda
re-corrible desde `preparar`. Los crudos quedan en `.run/datos/` (gitignored).

---

• *Generado con [Wingworking](https://wingworking.org)*

---

## V-16 · La PRIMERA promoción cuando el activo es un nodo SIN identidad de anillo (2026-09-03)

**Qué se prueba.** El caso que V2…V14 no cubren y que la instancia GH tiene por delante: el activo es
`benchv14-vergis-1`, un nodo **sin `VERGIS_RING`** ruteado por `active.caddy` como `vergis:8080` (lo que
`mira-vergis-1` será tras migrar el borde), y el primer anillo (`vergis-9-9-1`, misma imagen) lo releva.
Orquestador propio: [`scripts/bench16.sh`](scripts/bench16.sh) (no toca `bench.sh`); wrapper bajo prueba:
[`experimentos/v16/wrapper-bajo-prueba.sh`](experimentos/v16/wrapper-bajo-prueba.sh) (el `07-primera-promocion.sh`
del lab con rutas parametrizadas). Hipótesis de mecanismo (plan `work/231` §2 del lab): con «no hay anillo
activo vivo» la herramienta flipea y espera un relevo que el intent no otorga; el titular solo suelta con
`SIGUSR2`. Predicado y controles: los de V-14, sin relajar.

### Corridas

| # | Imagen | Resultado | Qué enseñó |
|--|--|--|--|
| 1 | v0.24.0 | V-16a ✓ · V-16b-cn ✓ (falla como se predijo) · V-16b ✓ · **V-16c ✗** | **#282**: el anillo había recibido un `SIGUSR2` en standby (lo manda `vergis-rollout` al candidato al abortar) y su `soltando` quedó pegado con una promesa resuelta. Medido con el inspector de Node sobre el proceso atascado: `soltando`=Promise, `hasControl()`=true, `loops.armed()`=true, `noAspirarHasta`=0 ([crudo](experimentos/v16/inspector-soltando-cerrojo.txt), [sonda](experimentos/v16/inspector-sonda.mjs)). Corregido en 0.25.1 (`singleFlight`) |
| 2 | v0.25.1 | V-16c ✓ (7 s) · **V-16d ✗** (estado final malo) | La promoción abortada dejó al candidato con el control y el borde apuntando al nodo compose en standby: la herramienta manda `USR2` al candidato **antes** de que adquiera (14:41:23.314) y éste adquiere 180 ms después (14:41:23.496). CERO serving detrás del borde. → guardia post-abort en el wrapper |
| 3 | v0.25.1 | inválida | `preparar` no retiraba el anillo de la corrida anterior; el nodo compose nunca llegó a serving y V-16d midió otro mundo |
| 4 | v0.25.1 + wrapper con guardia | V-16d ✓ (guardia disparada, compose serving a los 8 s) · V-16b ✓ · V-16c con **404 en /impresiones** | Artefacto del banco, no del Producto: `preparar` borraba `control.lease.json` con los stores estampados en época 8; el nodo compose arrancó con época 4 y **deshabilitó notas y administración por diseño** (fail-closed). Las 8 impresiones «perdidas» estaban en el sqlite. Lección de runbook: **jamás borrar el lease con stores estampados** |
| **5** | **v0.25.1 + wrapper con guardia** | **TODO VERDE** | La que vale. Tabla abajo. [Log](experimentos/v16/corrida-5-v0.25.1-final.log) · [crudos](experimentos/v16/crudos-corrida-5-v0.25.1/) |

### Corrida 5 · cifras (predicado `200 ∧ phase=serving`, poller por `:8079`, mutador 1/s)

| Corrida | Esperado | Medido | Veredicto |
|--|--|--|--|
| CN-instrumento A (poller directo al anillo en espera) | 0 OK, todo MAL | 495 MAL · 0 OK | ✓ |
| CN-instrumento B (destino inexistente) | 0 OK, todo SINMEDIR | 274 SINMEDIR · 0 OK | ✓ |
| V-16a `install` con el nodo compose activo | anillo standby, compose serving, lease sin cambio | rc=0 · anillo `standby` · compose `serving` · titular idéntico antes/después | ✓ |
| **V-16b-cn** `promote` A SECAS | el candidato NO llega a serving; la herramienta vuelve atrás | rc=1 · «el candidato NO llegó a 'serving' (fase: standby)… Se vuelve atrás» · **441 respuestas 503 en 13,8 s** (el costo del intento) · 23/23 impresiones vivas | ✓ **mecanismo confirmado: sin señal no hay relevo** |
| **V-16b** wrapper (`SIGUSR2` al nodo compose al ver el flip) | 0 fuera de predicado, 0 5xx, 0 pérdidas; anillo serving, compose standby | **0 fuera de predicado** · 103/103 OK · retención p95 1.006 ms · p100 1.078 ms · 3/3 mutaciones · 24/24 impresiones vivas **y en sqlite** | ✓ |
| **V-16c** vuelta atrás manual (anillo → compose) | compose vuelve a serving sin errores crudos; retención ≤ 10 s | **0 fuera de predicado** · 34/34 OK · retención p100 507 ms · «nodo compose re-adquirió a los 7s» · 21/21 vivas y en sqlite | ✓ |
| **V-16d** promoción abortada (`RINGS_PROMOTE_TIMEOUT=1`) | la herramienta vuelve atrás; compose re-adquiere; sin error crudo | rc=1 · abort · **guardia**: «el candidato tomó el control DESPUÉS del abort… SIGUSR2» → «compose volvió a serving a los 7s» · **51 respuestas 503 en 1,58 s** + retención p100 9.067 ms · 11/12 mutaciones (1 × 503 explícito) · 32/32 impresiones vivas y en sqlite | ✓ con costo declarado: **un abort cuesta ~1,6 s de sala de espera y hasta ~9 s de retención**, no «solo retención» como decía el plan |
| V-RSS | ambos < 2 GB | compose 99 MiB · anillo 91 MiB · borde 55 MiB (límite 1 GiB en el banco) | ✓ |

Durabilidad, medida en el archivo y no en el nodo que sirve: los 100 ids que recibieron 200 en las cuatro
corridas medidas (23 + 24 + 21 + 32) están en `notas.sqlite`; `control_meta` firmado por el último titular
(época 16). Stores del nodo compose al final en modo `write`, épocas sanas.

### Lo que cambia para la instancia

1. **La primera promoción se hace con 0.25.1 o superior** (#282): con 0.24.0, cualquier abort deja al candidato incapaz de soltar el control.
2. **El wrapper lleva guardia post-abort** (`07-primera-promocion.sh` del lab actualizado en el mismo acto).
3. **El costo de un abort se declara**: ~1,6 s de 503 y ~9 s de retención, y las escrituras de esa ventana fallan explícitas (503/409), no se pierden.
4. **El lease no se borra nunca** con stores estampados: un nodo que arranca con época menor que la del archivo deshabilita notas y administración (fail-closed, correcto) y parece «perder» datos.

### Teardown

`sh scripts/bench.sh limpiar` (los `benchv14-*` y `vergis-9-9-1` abajo). Crudos pesados (`poller.jsonl`, `mutaciones.jsonl`, logs) fuera del repo; los veredictos, actos e impresiones de cada corrida en `experimentos/v16/crudos-corrida-N-*/`.
