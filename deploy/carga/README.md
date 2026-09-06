# `deploy/carga` — el arnés de la prueba de carga a UN nodo

> **Qué es.** El instrumento que mide **cuánto aguanta un nodo Botler**, familia por familia, con la
> misma ley que el banco V-14 le exige a su poller: cada request es un par (t-envío, t-respuesta) con
> su veredicto en un JSONL crudo, `SINMEDIR ≠ MAL`, predicado completo por clase, y **control
> negativo obligatorio antes de creer un solo número**.
>
> Es el hito **H1** del plan `work/013-cluster-botler-generico/06-plan-escala-a-millones-v1.0.md`.
> **H1 no construye: mide.** Los números que salen de acá son los que rellenan el modelo de capacidad
> (`r_get`, `r_post`, `r_pi`, `m_nodo`) y deciden si los hitos siguientes son urgentes o de escala.
>
> Los resultados de las corridas reales viven en [`CORRIDAS.md`](CORRIDAS.md).

## ¿Qué hay acá?

| Archivo | Qué hace |
|---|---|
| `arnes.mjs` | El instrumento. Node ≥ 22, **sin dependencias**. Corre en el host o en un contenedor hermano, jamás dentro del sujeto |
| `lib.mjs` | El núcleo puro: predicado por clase, clasificador `OK\|MAL\|SINMEDIR`, familias de error, percentiles, agregación del crudo. Probado en `tests/carga-arnes.test.ts` |
| `lib.d.mts` | Los tipos de `lib.mjs`, para que el test en TypeScript pase por `npm run typecheck` |
| `veredicto.mjs` | El juez. Computa el veredicto **del archivo crudo**, nunca de la consola |
| `gen-instrumentos.mjs` | El generador de la instancia sintética de Daftar (spec, mapa de identidad, guías) |
| `CORRIDAS.md` | Las corridas reales, con su veredicto por familia |

## La ley del instrumento (las nueve reglas, y dónde se cumplen)

1. **Cada request es un par (t-envío, t-respuesta) con veredicto en un JSONL crudo.** El veredicto se
   computa del archivo (`veredicto.mjs`), nunca de la consola.
2. **`SINMEDIR ≠ MAL`.** Timeout, socket rechazado y tope de en-vuelo se anotan como `SINMEDIR` con
   motivo; un 5xx o un cuerpo que no cumple es `MAL`. Los dos se reportan por separado y ninguno se
   descarta.
3. **Predicado completo, por clase de request** (`juzgar()` en `lib.mjs`). Para `/healthz`,
   `200 ∧ phase=serving ∧ (¬lets ∨ lets.serving==lets.total)`, **parseado, no grepeado**.
4. **Errores por clase**, con el **409 de standby contado aparte**.
5. **p50/p95/p99/p100 por clase y por escalón**, del crudo, con percentil por orden (nearest-rank) y
   sin librerías: todo percentil es una latencia que de verdad ocurrió.
6. **Control negativo obligatorio, dos brazos** (`--esperar standby` y `--esperar rechazo`), con
   **rc≠0 si el resultado no es el esperado**: un control negativo verde no pasa en silencio.
7. **El arnés vive fuera del sujeto.**
8. **Escalera de carga, no un punto.** Concurrencia fija por escalón, calentamiento descartado, y
   parada en el primer escalón con `p95 > umbral` ∨ `MAL > 0,1 %` ∨ `SINMEDIR > 0`. El **techo** es el
   último escalón **dentro** de umbral.
9. **La configuración se lee del sujeto vivo**: antes de cada corrida se piden `/healthz` y
   `/contrato` (con el email admin) y se guardan versión, `protos`, `control` y drivers en el crudo.
   **Sin preámbulo no hay corrida** — salvo en el brazo `--esperar rechazo`, donde que el sujeto no
   conteste es justamente lo que se espera.

## El nodo Daftar local

```sh
# 1 · la imagen del árbol actual
docker build -t vergis:carga .

# 2 · la instancia sintética
node deploy/carga/gen-instrumentos.mjs --dir /tmp/carga-daftar --estudiantes 200 --siembra 0 --limpiar

# 3 · el nodo (sin motor de datos: ninguna spec consume datos gobernados)
C=/tmp/carga-daftar
docker run -d --name carga-daftar --init --memory 512m -p 127.0.0.1:8080:8080 \
  -e VERGIS_SPECS_DIR=/specs -e VERGIS_INSTRUMENTOS_DIR=/instrumentos -e VERGIS_EVALUACIONES=1 \
  -e VERGIS_IDENTITY_MAP=/identity/map.json -e VERGIS_OUT=/governance \
  -e VERGIS_ADMIN_SEED=admin@carga.local -e VERGIS_CONTROL=lease \
  -v $C/specs:/specs:ro -v $C/instrumentos:/instrumentos:ro -v $C/identity:/identity:ro \
  -v $C/governance:/governance vergis:carga

# 4 · el standby para CN-A: MISMO VERGIS_OUT, otro puerto
docker run -d --name carga-daftar-standby --init --memory 512m -p 127.0.0.1:8090:8080 \
  … (los mismos env y montajes, incluido -v $C/governance:/governance) … vergis:carga
```

> ⚠ **`VERGIS_OUT` en un bind-mount de macOS degrada el store bajo escritura sostenida.** Está medido
> con control (ver `CORRIDAS.md` § «El hallazgo»): con `-v $C/governance:/governance` la siembra murió
> a los 819 intentos y el nodo quedó **permanentemente** en 500; con `-v cargavol:/governance`
> (volumen nombrado) los 5.000 entraron sin un fallo. Para cualquier corrida con escritura sostenida
> se usa un **volumen nombrado** — recordando `chown` inicial, porque la imagen corre como `node`:
>
> ```sh
> docker volume create cargavol
> docker run --rm -v cargavol:/g --user 0 vergis:carga sh -c 'chown -R node:node /g'
> ```

## El nodo Mira local

**No se duplica: se reusa el banco V-14.**

```sh
cd deploy/rollout/bench && sh scripts/bench.sh preparar   # imagen + ClickHouse sembrado + 9 PIs
```

El arnés corre como **contenedor hermano** en la red `benchv14` (el nodo no publica puertos al host):

```sh
docker run --rm --network benchv14 -v "$PWD/deploy/carga":/carga:ro -v "$PWD/deploy/carga/.run":/datos \
  --entrypoint node vergis:carga /carga/arnes.mjs --perfil mira --url http://vergis-9-9-1:8080 \
  --mira-email banco@v14.local --admin-email banco@v14.local \
  --vu 1,5,10,25,50,100,200 --dur 60 --warmup 10 --p95-max 1000 --out /datos/mira-ch.jsonl
```

Ahí dentro no hay CLI de docker, así que `docker stats` lo muestrea un lazo del host a un archivo
aparte que después se **concatena** al crudo; `veredicto.mjs` le infiere el escalón por su ventana
temporal (una muestra fuera de toda ventana queda **sin atribuir**, no se le inventa una).

## Los comandos

```sh
# la serie
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8080 --slug carga \
     --vu 1,5,10,25,50,100,200 --dur 60 --warmup 10 --p95-max 200 \
     --contenedor carga-daftar --out deploy/carga/.run/daftar-S0.jsonl

# CN-A · el instrumento VE el fallo (nodo en standby ⇒ 100 % 409 en las escrituras)
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8090 --slug carga \
     --vu 5 --dur 10 --warmup 0 --esperar standby --out deploy/carga/.run/cn-a.jsonl

# CN-B · el instrumento DISTINGUE «no pude medir» (puerto sin nadie ⇒ 100 % SINMEDIR:rechazo)
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8099 --slug carga \
     --vu 5 --dur 5 --warmup 0 --esperar rechazo --out deploy/carga/.run/cn-b.jsonl

# la siembra de la serie S₁ (5.000 intentos POR POST, jamás tocando el archivo)
node deploy/carga/gen-instrumentos.mjs --dir /tmp/carga-daftar --estudiantes 200 --siembra 5000
docker restart carga-daftar    # el mapa de identidad se lee al arrancar
node deploy/carga/arnes.mjs --perfil daftar --url http://127.0.0.1:8080 --slug carga \
     --sembrar 5000 --out deploy/carga/.run/siembra.jsonl

# el veredicto, computado del archivo
node deploy/carga/veredicto.mjs deploy/carga/.run/daftar-S0.jsonl --p95-max 200
```

### Banderas

| Bandera | Qué hace |
|---|---|
| `--perfil daftar\|mira` | Qué perfil de tráfico se emite |
| `--url` · `--slug` | El sujeto y, en Daftar, el slug del Let |
| `--vu 1,5,10,…` | La escalera de concurrencia (un escalón por valor) |
| `--dur` · `--warmup` | Segundos por escalón y segundos de calentamiento descartado |
| `--p95-max` | Umbral de p95 (ms) para la parada. Sin él, la escalera no para por latencia |
| `--esperar standby\|rechazo` | Brazo de control negativo: rc≠0 si el resultado no es el esperado |
| `--contenedor` | Contenedor a muestrear con `docker stats` cada `--stats-cada` segundos |
| `--sembrar N` | Modo siembra: N intentos por `POST` y termina (no corre la escalera) |
| `--k` | `POST`s de progreso por vuelta de estudiante virtual (default 3) |
| `--umbral-clases` | Acota **qué clases paran** la escalera. No relaja el predicado: cada request se juzga igual y la tabla reporta todas |
| `--sin-reverificar` | Salta el cero-pérdidas (por defecto se relee cada intento escrito) |

## El perfil `daftar`, calcado del frontend

De `packages/daftar/assets/app.js`: entra (`GET /<slug>/`, `GET api/guides`), abre una guía
(`GET api/guides/<id>`, `GET api/progress/<id>`), responde **k** veces
(`POST api/progress/<id>` con el cuerpo que arma `saveProgress()`), y cierra mirando el
reporte (`GET report/<id>`).

**Un estudiante virtual = su propio email y su propio instrumento.** El intento tiene clave
`(instrumento, estudiante)` y el dueño lo fija el metadato de la guía (`let.ts`), así que una guía
compartida haría que los N estudiantes escribieran la misma fila: se mediría serialización sobre un
registro, no concurrencia. Por eso el generador emite una guía por estudiante.

**El progreso está acotado**: cuando el estudiante virtual termina su instrumento, empieza uno nuevo.
Sin ese corte el `answers` crecía sin tope durante la corrida y la latencia derivaba por una causa
del arnés — está medido lo que pasa sin él, en `CORRIDAS.md`.

## El perfil `mira`

`GET /<slug>` rotando los 9 PIs del banco con la identidad de un consumidor válido. El **invariante
de contenido** no se inventa: se calibra del sujeto vivo en el preámbulo (una lectura por PI, de la
que se extrae el `<title>`) y queda anotado en el crudo.

## Cero pérdidas

Al cerrar la corrida se relee **cada** intento escrito (`GET api/progress/<id>`) y se compara con lo
enviado. No es deep-equal total: el servidor **agrega** `last_updated`, así que se compara el
subconjunto enviado —todo lo que se mandó tiene que volver idéntico— y lo agregado se reporta aparte.

---

• *Generado con [Wingworking](https://wingworking.org)*
