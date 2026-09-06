# CORRIDAS — prueba de carga a UN nodo (H1)

> **Qué es esto.** El registro de las corridas **reales** del arnés de `deploy/carga`, con sus
> números crudos y su veredicto. Nada de acá se estimó: cada fila sale de un JSONL que el
> `veredicto.mjs` volvió a juzgar del archivo. **Lo que no se midió se dice con esas palabras.**
>
> Los crudos viven en `deploy/carga/.run/` (gitignored: son dato de corrida, no fuente).

## La máquina y el sujeto

| | |
|---|---|
| **Máquina** | MacBook (Darwin 25.5.0), 16 GB de RAM, 10 CPU · Docker Desktop 29.5.2 con **8 GB / 10 CPU** asignados a la VM |
| **Fecha** | 5–6 de septiembre de 2026 (todas las horas en UTC, como el crudo) |
| **Sujeto** | imagen `vergis:carga` construida del worktree `feat/carga-h1` (rama de `main@fbf90c9`) |
| **Versión leída del `/contrato` del sujeto vivo** | `0.27.0` · `protos = [mira, daftar]` · `engine = clickhouse` |
| **Tope de recursos** | `--memory 512m` por nodo Daftar. Los anillos del banco V-14 corren con `--memory 1g` porque es **su** `ring.args.tmpl` y el brief manda reusar el banco, no duplicarlo |
| **Puertos del host** | 8080 (nodo activo) · **8090** (standby) · 8099 (CN-B, sin nadie). **El 8081 del brief estaba ocupado** por un proceso Python ajeno al experimento (`lsof`: `Python 98676`), así que el standby se movió al 8090 y queda anotado |
| **El arnés vive fuera del sujeto** | Daftar: proceso del host. Mira: contenedor hermano en la red `benchv14` (el nodo del banco no publica puertos al host) |

---

## 1 · Controles negativos — **antes** de la primera serie

### CN-B · el instrumento distingue «no pude medir» — `2026-09-06T02:28:07Z`

```sh
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8099 --slug carga \
     --vu 5 --dur 5 --warmup 0 --esperar rechazo --out deploy/carga/.run/cn-b.jsonl
```

| | |
|---|---|
| Preámbulo | **el sujeto no respondió** (`rechazo`) — que es exactamente lo esperado en este brazo |
| Resultado | **28.000 requests · OK = 0 · MAL = 0 · SINMEDIR:rechazo = 28.000** |
| Veredicto | ✅ **VE LA AUSENCIA DE EVIDENCIA** (rc = 0). 100 % `SINMEDIR:rechazo`, cero `MAL`, cero `OK` |

### CN-A · el instrumento ve el fallo — `2026-09-06T02:29:13Z`

Segundo nodo (`carga-daftar-standby`, puerto 8090) sobre **el mismo `VERGIS_OUT`** que el activo.

```sh
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8090 --slug carga \
     --vu 5 --dur 10 --warmup 0 --esperar standby --out deploy/carga/.run/cn-a.jsonl
```

| | |
|---|---|
| Preámbulo | `healthz = 200` · **`phase = standby`** · `/contrato = 200` · versión `0.27.0` · `protos [mira, daftar]` · `control.lease.held = false`, `reason = held-by-other` · los cuatro stores abiertos en **`mode: read`** |
| Escrituras | **8.058 · `409-standby` = 8.058 · OK = 0** |
| Lecturas | 13.430 OK, cero MAL (un standby **sí** sirve lecturas: p95 `shell` 5 ms, `guides` 4 ms) |
| Veredicto | ✅ **VE EL FALLO** (rc = 0) |

> **La primera corrida de CN-A salió con un rojo que no era del sujeto**, y por eso está anotada: el
> arnés calibraba el invariante del `report` de la guía 0 y se lo exigía a las 200, marcando
> `falta-invariante` en 4 de cada 5. Se corrigió (el invariante pasó a ser **plantilla por
> instrumento**) y se volvió a correr. Un instrumento que no sabe reportar su propio fallo produce
> datos con cara de verdad: acá el fallo era del instrumento y lo dijo.

**Ningún control negativo salió verde-inesperado. Las series de abajo se publican con eso ya medido.**

---

## 2 · Daftar — la escalera

Perfil calcado del frontend: por vuelta de estudiante virtual, `shell` + `guides` + `guia` +
`progress-get` + **3 × `progress-post`** + `report`. Umbral: **p95 ≤ 200 ms**, `MAL ≤ 0,1 %`,
`SINMEDIR = 0`. Escalera `1,5,10,25,50,100,200` VU · 60 s por escalón · 10 s de calentamiento
descartado. `docker stats` cada 5 s al crudo.

### 2.1 · S₀ — store vacío, catálogo de 200 guías, `VERGIS_OUT` en bind-mount — `02:33:53Z`

```sh
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8080 --slug carga \
     --vu 1,5,10,25,50,100,200 --dur 60 --warmup 10 --p95-max 200 \
     --contenedor carga-daftar --out deploy/carga/.run/daftar-S0.jsonl
```

p50 / p95 / p99 en ms, por clase y escalón (solo `OK`; **cero `MAL` y cero `SINMEDIR` en toda la corrida**):

| VU | shell | guides | guia | progress-get | progress-post | report | TOTAL n | rps total |
|--|--|--|--|--|--|--|--|--|
| 1 | 1,9 / 4,9 / 6,3 | 1,8 / 3,3 / 5,0 | 0,8 / 1,9 / 3,7 | 0,9 / 1,8 / 3,1 | 3,6 / **5,0** / 7,4 | 1,3 / 2,7 / 4,6 | 25.232 | 421 |
| 5 | 6,1 / 12,7 / 16,7 | 6,4 / 13,5 / 17,2 | 5,7 / 12,9 / 16,8 | 5,1 / 11,4 / 15,4 | 7,9 / **15,0** / 19,0 | 6,0 / 13,3 / 17,1 | 41.656 | 694 |
| 10 | 12,4 / 26,7 / 31,9 | 12,4 / 27,1 / 33,2 | 11,4 / 26,2 / 31,9 | 12,6 / 25,1 / 30,7 | 13,9 / **28,5** / 34,8 | 11,0 / 25,7 / 31,5 | 42.384 | 705 |
| 25 | 31,7 / 63,9 / 79,8 | 30,8 / 62,7 / 77,8 | 29,9 / 60,9 / 77,5 | 31,9 / 64,8 / 80,3 | 34,5 / **69,9** / 86,9 | 30,9 / 59,9 / 78,1 | 41.880 | 696 |
| **50 (techo)** | 68,5 / 127,0 / 164,8 | 68,8 / 132,2 / 162,8 | 68,1 / 130,0 / 161,5 | 68,9 / 136,7 / 162,1 | 69,9 / **134,8** / 164,3 | 67,1 / 106,5 / 153,7 | 39.904 | 661 |
| 100 ✖ | 143,3 / **239,5** / 302,7 | 143,4 / **248,7** / 304,6 | 142,8 / **204,3** / 301,0 | 142,9 / **270,5** / 307,1 | 144,4 / **250,7** / 304,4 | 142,2 / 172,2 / 291,2 | 39.576 | 652 |

- **Errores por clase: ninguno.** Cero 4xx, cero 5xx, cero `409-standby`, cero timeouts, cero rechazos.
- **Contenedor en el techo (50 VU):** CPU máx **80,9 %** (media 77,4 %) de **un** core · **RSS máx 97,5 MB** (límite del anillo: 512 MB).
- **Cero pérdidas: 100/100 idénticos**, 0 distintos, 0 sin respuesta.
- **Techo = 50 VU.** Se rompió en 100 VU por p95 en cinco de las seis clases.
- **`r_post`(S₀) ≈ 248 POST/s · `r_get` ≈ 83 rps por clase de lectura (≈ 330 rps de lectura en total).**

> **Esta corrida se rehízo.** La primera versión del perfil dejaba crecer `answers` **sin tope** a lo
> largo de la corrida: el cuerpo del `POST` y la fila del store engordaban con el tiempo y la latencia
> derivaba **por una causa del arnés**. Con ese defecto el techo daba **5 VU** y `r_post` ≈ 25 POST/s —
> un factor 10 de diferencia contra el mismo sujeto. Se acotó el progreso (terminado el instrumento,
> empieza otro) y se volvió a medir con el store vacío. **El número publicado es el de después.**

### 2.2 · S₀′ — store vacío, catálogo de **5.200** guías, `VERGIS_OUT` en volumen nombrado — `02:44:51Z`

Es la línea base **comparable con S₁**: mismo substrato y mismo catálogo, y lo único que cambia entre
las dos es el tamaño del store.

| VU | shell | guides | guia | progress-get | progress-post | report | TOTAL n | rps total |
|--|--|--|--|--|--|--|--|--|
| 1 | 2,1 / 4,0 | **20,7 / 23,3** | 1,4 / 2,4 | 1,3 / 2,3 | 3,4 / **5,0** | 1,5 / 2,6 | 12.416 | 207 |
| 5 | 6,8 / 41,8 | 27,4 / 61,2 | 8,0 / 42,8 | 5,8 / 38,6 | 9,3 / **44,3** | 7,5 / 43,0 | 17.168 | 286 |
| **10 (…)** | 29,7 / 72,5 | 47,5 / 89,1 | 28,0 / 71,6 | 28,9 / 69,9 | 29,5 / **71,4** | 26,6 / 70,9 | 17.248 | 287 |
| **25 (techo)** | 78,2 / 157,3 | 95,4 / 184,1 | 73,0 / 155,4 | 80,7 / 169,8 | 81,6 / **168,7** | 75,8 / 150,3 | 17.024 | 283 |
| 50 ✖ | 167,1 / **297,5** | 188,4 / **345,4** | 164,2 / **282,8** | 170,4 / **329,3** | 161,9 / **325,9** | 156,8 / **252,2** | 16.800 | 277 |

(p50 / p95 en ms.) **Cero MAL, cero SINMEDIR. Cero pérdidas: 50/50 idénticos.** Contenedor en el
techo: CPU media ~73 %, RSS máx ~112 MB. **Techo = 25 VU.**

### 2.3 · S₁ — **5.000 intentos sembrados por `POST`**, mismo catálogo y substrato — `02:51:27Z`

Siembra previa: `--sembrar 5000` → **5.000 ok · 0 fallos**. Store `evaluaciones.sqlite`:
**3,92 MB** (≈ 785 B por intento) contra los ~0 KB de S₀′.

| VU | shell | guides | guia | progress-get | progress-post | report | TOTAL n | rps total |
|--|--|--|--|--|--|--|--|--|
| 1 | 2,3 / 4,3 | 22,4 / 26,0 | 1,4 / 2,7 | 1,4 / 2,5 | 7,8 / **10,2** | 1,9 / 7,8 | 8.104 | 135 |
| 5 | 17,1 / 49,5 | 39,6 / 72,7 | 19,5 / 53,4 | 16,3 / 46,8 | 26,8 / **60,5** | 21,1 / 56,0 | 10.096 | 168 |
| **10 (techo)** | 45,9 / 105,1 | 68,8 / 127,5 | 45,1 / 106,0 | 48,6 / 104,1 | 50,5 / **112,4** | 40,2 / 95,3 | 10.200 | 169 |
| 25 ✖ | 116,5 / **256,4** | 135,7 / **280,7** | 110,3 / **259,9** | 121,9 / **276,4** | 123,1 / **274,7** | 109,6 / **225,3** | 10.488 | 173 |

**Cero MAL, cero SINMEDIR. Cero pérdidas: 25/25 idénticos.** Contenedor en el techo: CPU media
**118 %**, RSS máx **137 MB**. **Techo = 10 VU.**

### 2.4 · La hipótesis del plan, contrastada

> «`r_post` cae linealmente con el tamaño de `evaluaciones.sqlite`, porque cada `POST` reescribe el
> archivo entero (`sqlite.ts:139-176`)» — doc 06, § Modelo de capacidad · Daftar.

**No se refuta: se corrobora en dirección, y la forma NO es lineal en el rango medido.**

| | S₀′ (store ~vacío) | S₁ (3,92 MB · 5.000 intentos) | factor |
|---|---|---|---|
| p95 de `POST` a 1 VU | **5,0 ms** | **10,2 ms** | ×2,0 |
| p95 de `POST` a 5 VU | 44,3 ms | 60,5 ms | ×1,4 |
| p95 de `POST` a 10 VU | 71,4 ms | 112,4 ms | ×1,6 |
| Techo | 25 VU | **10 VU** | ÷2,5 |
| `r_post` en el techo | ≈ 106 POST/s | ≈ **64 POST/s** | ÷1,7 |
| CPU media del contenedor | ~73 % | ~118 % | ×1,6 |

El costo por `POST` **se duplicó** yendo de un store vacío a uno de 3,92 MB, con el resto del mundo
igual: es el volcado completo, y el que crece es el archivo. **Lo que NO se midió** es la forma de la
curva: dos puntos no distinguen lineal de raíz de logarítmica, y el brief pedía dos puntos. Para
decir «lineal» harían falta al menos cuatro tamaños; hoy es **conjetura**.

> **Confundido declarado y cómo se neutralizó.** Un intento es un par `(instrumento, estudiante)` y el
> dueño lo fija el metadato de la guía (`packages/daftar/src/let.ts`), así que **5.000 intentos exigen
> 5.000 guías más**: entre un catálogo de 200 y uno de 5.200 la clase `guides` deja de ser comparable.
> Por eso la línea base de la comparación es **S₀′, corrida con el catálogo ya crecido**: entre S₀′ y
> S₁ lo único que cambia es el store. El costo del catálogo se ve solo, comparando §2.1 con §2.2:
> `guides` a 1 VU pasa de **3,3 ms** (200 guías) a **23,3 ms** (5.200) y el techo del nodo cae de 50 a
> 25 VU — el `listar()` de `packages/daftar/src/instrumentos.ts` recorre el directorio entero en cada
> `GET /api/guides`, y el nodo es de un solo hilo, así que ese costo lo pagan **todas** las clases.

---

## 3 · El hallazgo: el guard de escritura concurrente degrada el store en un bind-mount de macOS

**Esto salió del experimento, no de leer el código, y tiene su control.**

Durante la primera siembra (`02:41:38Z`, `VERGIS_OUT` en `-v /tmp/carga-daftar/governance:/governance`),
los `POST` empezaron a devolver **500** a partir del intento ~820 y **no se recuperaron nunca**:

```
819 ok · 4181 fallos
[store] ESCRITURA CONCURRENTE en '/governance/evaluaciones.sqlite': el archivo vigente
  (ino=113964 size=958464 mtime=1788662502937.676) no es el que dejó este handle
  (ino=113963 size=958464 mtime=1788662502937.676). Este nodo queda degradado.
```

**La huella difiere SOLO en el inodo**: mismo tamaño, mismo `mtime` hasta el microsegundo. No había
segundo escritor (el standby estaba detenido desde las `02:33`; y un segundo escritor habría cambiado
también tamaño y `mtime`). `persistSqliteDb` escribe a un tmp y hace `renameSync`, y compara la huella
del archivo vigente contra la que dejó **su propio** rename (`packages/capabilities/src/sqlite.ts:350-377`).

**Control con dos brazos, mismo binario, misma carga, mismo instante del día:**

| Brazo | `VERGIS_OUT` | Siembra de 5.000 intentos |
|---|---|---|
| **A** | bind-mount de macOS (`-v /tmp/…:/governance`) | **819 ok · 4.181 fallos** · store degradado de forma **terminal** |
| **B** | volumen nombrado (`-v cargavol:/governance`) | **5.000 ok · 0 fallos** |

Y B se repitió una segunda vez para la serie S₁: **5.000 ok · 0 fallos** otra vez.

**Lo medido:** el sustrato del `VERGIS_OUT` decide si el guard de escritura concurrente se dispara
solo. **Lo conjeturado** (y va con esa palabra): que la causa sea la caché de atributos del sistema
de archivos virtualizado de Docker Desktop para macOS, que devuelve el inodo previo en el `statSync`
inmediatamente posterior al `rename`. No se aisló **cuál** de los dos `statSync` es el rancio, ni se
probó fuera de Docker Desktop para macOS.

**Por qué importa aunque el sustrato sea de laboratorio:**

1. **La receta del propio brief usa bind-mount** (doc 06, § «Cómo se levanta el nodo Daftar local»),
   y con ella la serie S₁ **no se puede completar**. Quien repita H1 tal cual chocará con esto.
2. **La degradación es terminal por diseño** (`degradedGuards`, `packages/capabilities/src/sqlite.ts:176`): una sola detección
   —verdadera o falsa— deja el nodo devolviendo 500 en toda escritura hasta que alguien lo reinicie.
   No hay reintento, ni sonda, ni auto-recuperación; el `/healthz` sigue diciendo `phase=serving` y
   `ok:true`, así que **un balanceador no lo saca**. El predicado del proyecto no cubre este estado.
3. Confirma, por un camino que nadie buscó, la premisa de **H2**: mientras el store sea un archivo que
   se vuelca entero, su corrección depende del sistema de archivos que haya debajo.

**Qué NO dice este hallazgo:** que el guard esté mal. El guard existe para que dos escritores no se
pisen, y eso lo hace. Lo que está sin medir es si el componente `ino` de la huella es **necesario**
—`size` + `mtime` + la época del plano de control ya distinguen dos volcados distintos— o si conviene
que la detección sea **recuperable** en vez de terminal. Ambas son decisiones de diseño, y son de H2,
no de H1.

---

## 4 · Mira — la escalera contra ClickHouse — `02:58:14Z`

Banco V-14 (`sh scripts/bench.sh preparar`), **imagen reconstruida del worktree** para que el sujeto
sea la misma versión que en Daftar: la primera preparación reusó una imagen `0.26.0` de una corrida
anterior y se rehízo. Nodo `vergis-9-9-1` (`--memory 1g`, del `ring.args.tmpl` del banco), 9 PIs
sintéticos sobre `bench.areas` en ClickHouse 24.8. Umbral **p95 ≤ 1.000 ms**.

| VU | p50 | p95 | p99 | p100 | n | rps | CPU media | RSS máx |
|--|--|--|--|--|--|--|--|--|
| 1 | 6,1 | 8,0 | 8,9 | 17,1 | 9.492 | 158 | 26,6 % | 101 MB |
| 5 | 5,4 | 7,8 | 9,6 | 46,9 | 53.851 | 897 | 75,1 % | 110 MB |
| 10 | 8,8 | 12,7 | 17,2 | 65,3 | 65.506 | 1.092 | 87,5 % | 108 MB |
| 25 | 22,8 | 33,4 | 45,0 | 110,0 | 62.641 | 1.044 | 97,0 % | 113 MB |
| 50 | 48,1 | 68,0 | 88,3 | 263,8 | 60.064 | 1.001 | 106,8 % | 121 MB |
| 100 | 99,4 | 133,2 | 169,1 | 618,3 | 58.746 | 978 | 106,3 % | 128 MB |
| **200** | 192,6 | **241,4** | 280,8 | 1.801,6 | 60.990 | 1.014 | 110,6 % | **136 MB** |

- **Errores por clase: ninguno** en 371.290 requests juzgados. Cero MAL, cero SINMEDIR.
- **La escalera terminó SIN encontrar el techo: `r_pi ≥ 200 VU` a p95 = 241 ms.** El «≥» es literal:
  no se midió más arriba, así que el número **acota por abajo** y no dice dónde se rompe.
- **`r_pi` ≈ 1.000 rps por nodo**, con la meseta ya alcanzada en 10 VU y sostenida hasta 200.
- **`m_nodo` bajo carga: 136 MB de RSS** — 27 % del límite de 512 MB del anillo de Daftar.

### 4.1 · `t_render` / `t_motor` — el método, declarado

**El brazo del stub NO se midió, y la razón es la que el brief anticipa:** `servingCap` se asigna en
el arranque de `server/serve-rls.ts` y no hay hoy env ni capability inyectable que lo sustituya, así
que el stub exige **cambiar el Producto**. H1 mide, no construye. **Sin medir, con esa palabra.**

Se usa el método de resta que el brief deja como alternativa, con `system.query_log` de ClickHouse
sobre la ventana de la corrida:

```
consultas: 434.569   avg: 1,864 ms   p95: 7 ms   max: 81 ms
(SELECT … FROM system.query_log WHERE type='QueryFinish' AND query LIKE '%bench.areas%')
```

**434.569 consultas contra ~434.500 requests (los 371.290 juzgados más los ~63.000 de
calentamiento): una consulta por request, sin deduplicación observable.** Eso ya es un dato: con
**una sola identidad de consumidor** el `single-flight` y la data-cache no colapsan nada en esta
configuración (`VERGIS_DATA_CACHE_TTL_MS = 0` por defecto, `server/config.ts:400`).

| | Valor | Cómo se obtuvo |
|---|---|---|
| `t_motor` (servidor) | **1,86 ms** de media · p95 7 ms | Medido en ClickHouse, `system.query_log` |
| total por request a 1 VU | 6,1 ms p50 · 8,0 ms p95 | Medido por el arnés |
| `t_render` + ida y vuelta HTTP al motor | **≈ 4,2 ms** p50 (**cota superior** de `t_render`) | **Por resta** — no separa el render del viaje al motor |
| `t_render / t_motor` | **≈ 2,2 a 1 VU, por resta** | Ídem |

**Lectura, con su incertidumbre encima:** `t_render` **no** es despreciable frente a `t_motor` —son
del mismo orden, ambos de un dígito de milisegundos—, y el nodo satura a ~1.000 rps con **1,1 core**
mientras el motor responde en 1,9 ms. En ese régimen **agregar réplicas del Botler sí compra
capacidad de Mira**, hasta donde aguante el motor: 434 mil consultas en ~8,5 minutos son ~850 rps
sostenidos contra ClickHouse, y **ese** es el número que hay que vigilar al multiplicar nodos.
La resta arrastra el viaje HTTP al motor dentro de `t_render`, así que **la razón real es menor que
2,2**; el stub es lo que la separaría, y es trabajo de otro hito.

**Y una limitación que no se puede callar:** todo esto se midió con **un** consumidor
(`banco@v14.local`), porque el banco no tiene más identidades enroladas. Con RLS por consumidor cada
identidad paga su propia consulta (`server/serve-rls.ts`, «data-cache por consumidor»), así que estos
números **no** se extrapolan a N identidades sin volver a medir.

---

## 5 · Veredicto por familia (Disciplina 7)

### Daftar — **qué aguanta un nodo, qué se rompe primero**

Un nodo Daftar con el catálogo pequeño (200 instrumentos) y el store vacío aguanta **50 estudiantes
concurrentes** dentro de 200 ms de p95, sirviendo ~660 req/s con **0,8 de un core** y 98 MB de RSS —
lejísimos del límite de 512 MB. Con el catálogo de 5.200 instrumentos y 5.000 intentos en el store,
el mismo nodo aguanta **10**. **Lo que se rompe primero no es la memoria ni el disco: es el único
hilo del nodo**, y lo consumen dos cosas, en este orden:

1. **El `listar()` del catálogo**, que recorre el directorio completo en cada `GET /api/guides`
   (`packages/daftar/src/instrumentos.ts`): 3,3 ms con 200 guías, 23,3 ms con 5.200, y como el hilo es
   uno, ese costo lo pagan **todas** las clases del perfil, no solo el catálogo.
2. **El volcado completo del store en cada `POST`**, que duplica el costo de la escritura entre un
   store vacío y uno de 3,92 MB.

Con el margen de operación del plan (0,6), un nodo hoy sostiene ~30 estudiantes concurrentes en el
caso bueno y ~6 en el caso cargado. La instancia «estudios» tiene tres estudiantes: **para ella no
hay problema de capacidad, y no lo habrá por mucho tiempo.** El problema aparece al multiplicar
instancias o al crecer el catálogo, y aparece **antes por el catálogo que por el store**.

**Qué hito sube de prioridad.** **H2 (store a Postgres) sube**, y por un motivo distinto del que el
plan le atribuía: no es que `r_post` sea catastrófico —248 POST/s por nodo con el store vacío es
holgado—, es que **el archivo que se vuelca entero arrastra un modo de falla terminal y silencioso**
(§3) que ningún balanceador detecta. Y **aparece un candidato que el plan 06 no tiene: el catálogo de
instrumentos**, que hoy es el consumidor de CPU dominante del perfil de lectura y no está en la lista
de hitos. Merece su propia entrada — un índice en memoria invalidado por `mtime` del directorio, o el
catálogo al store — **antes** que N nodos, porque replicar no arregla un costo que cada réplica paga
igual.

### Mira — **qué aguanta un nodo, qué se rompe primero**

Un nodo Mira sostiene **≥ 200 usuarios concurrentes** a p95 de 241 ms y **~1.000 req/s**, con 1,1 core
y 136 MB de RSS: la escalera del brief **se terminó sin encontrar el techo**. El nodo se rompe por
**CPU de un solo hilo**, no por memoria (27 % del límite) ni por el motor (1,86 ms de media). La razón
`t_render/t_motor` es **≈ 2,2 por resta, cota superior**, y con el brazo del stub **sin medir**.

**Qué hito sube de prioridad.** **Ninguno por Mira.** Con ~1.000 rps por nodo, la aritmética del §6
del plan da un solo nodo para cualquier tamaño de A.R.B.O.L. que se pueda nombrar hoy, y H4 (N nodos
tras un balanceador) queda como trabajo **de escala**, no de urgencia. Lo que sí sube es una pregunta
que estas mediciones dejaron abierta y no está en la lista: **con una consulta por request y sin
caché compartida entre identidades, el que se satura al agregar nodos es el motor** — ~850 consultas
por segundo sostenidas ya salieron de un solo Botler. Antes de poner el segundo nodo hay que medir el
motor, no el Botler.

---

## 6 · Lo que NO se midió, con su razón

| Qué | Por qué |
|---|---|
| **Mira contra un motor stub** | `servingCap` se fija en el arranque de `server/serve-rls.ts`; no hay env ni capability inyectable, así que el stub exige tocar el Producto. H1 mide, no construye. **Sin medir** — `t_render` va estimado por resta, con su método declarado en §4.1 |
| **La forma de la curva `r_post(S)`** | Se midieron **dos** tamaños de store, que es lo que el brief pide. Dos puntos no distinguen lineal de raíz de logarítmica. Que la caída sea **lineal** es hoy **conjetura** |
| **Mira con N identidades de consumidor** | El banco V-14 tiene un solo consumidor enrolado. Con RLS por consumidor cada identidad paga su consulta, así que los números de §4 **no** se extrapolan |
| **La causa exacta del inodo rancio** (§3) | El control de dos brazos demuestra que el sustrato decide; **no** se aisló cuál `statSync` devuelve el valor viejo ni se probó fuera de Docker Desktop para macOS |
| **Daftar por encima de 100 VU y Mira por encima de 200** | La escalera para en el primer escalón que viola (regla 8). En Daftar paró antes; en Mira **no violó ninguno**, así que su techo está **acotado por abajo**, no medido |
| **El escalón de 200 VU en las tres series de Daftar** | La escalera paró antes por umbral. No hay dato de 200 VU para Daftar |
| **El borde del banco durante la serie de Mira** | El arnés apunta **al nodo**, que es lo que H1 mide. El conmutador tiene su propio arnés (V-14) |

---

• *Generado con [Wingworking](https://wingworking.org)*
