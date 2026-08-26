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

• *Generado con [Wingworking](https://wingworking.org)*
