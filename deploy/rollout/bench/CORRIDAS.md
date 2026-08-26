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

• *Generado con [Wingworking](https://wingworking.org)*
