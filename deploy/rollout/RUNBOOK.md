# Runbook — promover y volver atrás, con el corte medido

**Para quién es.** Para el operador que va a estrenar una versión del Producto en una instancia ya
migrada a anillos, o a volver atrás de una que estrenó. Es la **ceremonia**: la secuencia exacta, qué
se verifica después de cada paso, y cómo se deshace ese paso si la verificación no sale.

**Qué NO es.** No es la referencia de la herramienta —eso es [`README.md`](README.md), que explica qué
es un anillo, qué hace cada comando y cómo se prepara la instancia la primera vez—. Este archivo
asume eso leído y agrega lo que un README no lleva: **la ley del instrumento**. Porque el valor de
todo este mecanismo es una afirmación medible —«el serving no se interrumpió»— y una afirmación así
vale lo que valga el instrumento con que se midió.

Léelo completo **antes** de la primera promoción. Después se usa como lista, no como lectura.

---

## 0 · La ley del instrumento (esto es lo que distingue este runbook de un README)

Cinco reglas. Ninguna es opcional, y cada una existe porque su ausencia ya produjo un dato falso.

### 0.1 · El corte se mide. El comando miente

`docker restart` devuelve `rc=0` en **375 ms** y `docker compose up -d` en **1.292 ms** mientras las
rutas siguen sin servir durante segundos. Quien mide el corte por la duración del comando **se
equivoca por un factor de 9 a 20** (medido, 2026-08). La duración del acto **no** es la duración del
corte: lo que se mide es el intervalo en que el predicado de salud **no** se satisface.

### 0.2 · El predicado es la fase, jamás «responde»

```
sano  ⇔  HTTP 200  ∧  "phase":"serving"  ∧  pis.serving == pis.total
```

**Nunca `r.ok`. Nunca «2xx a secas». Nunca «el curl volvió».** Un nodo **en espera** responde `200`
con `ok:true` **por diseño**: está sano, sirve lecturas y **no** tiene el plano de control — sus
mutaciones contestan 409. Un poller que juzgue por el código HTTP mide un corte de cero donde hubo
un tramo entero sin nadie sirviendo tráfico de escritura. El mismo predicado rige en los tres lugares
donde se juzga: el health check de Caddy, el smoke de la herramienta y este poller.

### 0.3 · El poller vive en un contenedor que el acto NO recrea

Un poller efímero —`docker run --rm` lanzado en el mismo acto, o un proceso dentro del contenedor que
se está tocando— **muere durante el acto** y su serie termina donde empezó el corte: eso **acota el
corte por abajo** y se lee como si el corte hubiera sido corto. El poller va en un contenedor de vida
larga de la red interna que el acto **no** toca — el propio borde sirve, y cualquier sidecar estable
también.

### 0.4 · El control negativo es obligatorio

Una medición cuyo instrumento **no demostró saber ver el fallo** no vale, por más verde que salga.
Antes de creerle un «cero respuestas no servidas», el poller tiene que haber producido un **rojo** en
una corrida donde el fallo estaba presente a propósito. Sin ese rojo, «no vi el fallo» y «no puedo
ver el fallo» son indistinguibles — y ya salieron **dos mediciones ciegas** que solo el control
negativo delató.

### 0.5 · Un control negativo puede salir verde y ser FALSO: la config degradada nunca llegó al sujeto

Esto le pasó a este mismo mecanismo, medido en un e2e local: se bajó `lb_try_duration` a `1ms` en el
`Caddyfile` del host para forzar el fallo, el control salió **verde** (el borde siguió reteniendo
90 s) y la conclusión «el instrumento no sabe ver el fallo» habría sido **falsa**: el sujeto nunca
recibió la config degradada. El compose monta el `Caddyfile` como **archivo**, y un editor —o un
`sed -i`— **reemplaza el archivo y cambia su inodo**: el contenedor sigue viendo el contenido viejo y
`caddy reload` recarga lo mismo de antes, en silencio.

**La regla que se deriva:** la configuración se verifica **leyéndola del sujeto vivo**, no del archivo
que editaste.

```sh
# Lo que ve el CONTENEDOR (esto es el sujeto):
docker exec "$EDGE" grep -n lb_try_duration /etc/caddy/Caddyfile
# Y lo que tiene CARGADO ahora mismo (su API de administración: la verdad última):
docker exec "$EDGE" wget -q -O- http://127.0.0.1:2019/config/ | grep -o 'try_duration[^,]*'
```

Vías sanas para degradar la config de un montaje de **archivo**: `docker cp` al contenedor, editar
**dentro** (`docker exec … sh -c 'sed -i …'`), o montar el **directorio** en vez del archivo. Esto
**no** afecta a `rings/active.caddy`: vive en un montaje de directorio y la herramienta lo reescribe
preservando el inodo.

### El poller, escrito

Corre **antes** del acto y sigue corriendo después. Vive en el borde (`docker exec`), que la
promoción no recrea, y sondea **por el conmutador** (`:8079`), que es el camino del tráfico real.

```sh
EDGE=caddy   # el nombre de tu contenedor del borde (RINGS_EDGE)

docker exec "$EDGE" sh -c '
  fallos=0; total=0
  while :; do
    total=$((total+1))
    b=$(wget -q -T 2 -O- http://127.0.0.1:8079/healthz 2>/dev/null) || b=""
    ph=$(printf "%s" "$b" | sed -n "s/.*\"phase\":\"\([a-z-]*\)\".*/\1/p")
    sv=$(printf "%s" "$b" | sed -n "s/.*\"serving\":\([0-9]*\).*/\1/p")
    tt=$(printf "%s" "$b" | sed -n "s/.*\"total\":\([0-9]*\).*/\1/p")
    # El predicado COMPLETO. Cuerpo vacío = no se pudo medir, y eso cuenta como fallo, no se omite.
    if [ -n "$b" ] && [ "$ph" = serving ] && [ -n "$sv" ] && [ "$sv" = "$tt" ]; then
      printf "%s ok  fase=%s pis=%s/%s\n" "$(date -u +%H:%M:%S)" "$ph" "$sv" "$tt"
    else
      fallos=$((fallos+1))
      printf "%s NO-SERVIDA fase=%s pis=%s/%s (fallos=%s de %s)\n" \
        "$(date -u +%H:%M:%S)" "${ph:-sin-respuesta}" "${sv:-?}" "${tt:-?}" "$fallos" "$total"
    fi
    sleep 0.25
  done' | tee /tmp/poller-$(date +%Y%m%d-%H%M).log
```

- Resolución **0,25 s**: el corte que se busca acotar es de segundos.
- `pis.serving == pis.total` importa tanto como la fase: un nodo que sirve la mitad de los PIs
  responde `200` y `phase:degraded` — y eso **es** una respuesta no servida para la mitad de la gente.
- **Un cuerpo vacío es un fallo, no un dato ausente.** «No pude medir» nunca se cuenta como verde.
- Ajusta `sed`/`wget` a las herramientas de tu imagen del borde; lo que **no** se ajusta es el
  predicado.

### El control negativo, escrito

Se corre **una vez por instalación**, y de nuevo cada vez que cambie el poller o la config del borde:

1. Degrada la retención **dentro del sujeto** (no en el host):
   `docker exec "$EDGE" sh -c 'sed -i "s/lb_try_duration 90s/lb_try_duration 1ms/" /etc/caddy/Caddyfile'`
2. **Verifica que llegó**, leyendo del sujeto vivo (§0.5). Si el API de administración sigue
   declarando 90 s, **el control no está armado** y lo que sigue no mide nada.
3. `docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile` y detén el anillo activo
   (`docker stop`).
4. **Esperado: el poller cuenta NO-SERVIDAS.** Si sale verde, el instrumento está ciego → arréglalo
   antes de medir nada real.
5. Restaura la config, recárgala, **verifícala del sujeto vivo** otra vez, y vuelve a arrancar el
   anillo.

---

## 1 · Antes de tocar nada (todo esto es read-only)

| # | Comando | Qué tiene que salir |
|--|--|--|
| 1.1 | `vergis-rollout status` | El activo y el previo declarados, con sus digests, y el borde apuntando al activo |
| 1.2 | `docker exec $EDGE wget -q -O- http://127.0.0.1:8079/healthz` | `phase:"serving"` y `pis.serving == pis.total` — **el punto de partida está sano**. Si ya está degradado, esto no es una promoción: es un incidente |
| 1.3 | `docker inspect --format '{{index .Config.Labels "vergis.schema.stores"}}' ghcr.io/gegolabs/vergis:<candidata>` | El esquema que la candidata soporta, store por store. Descarta un rollback incompatible **sin arrancar nada** (necesario, no suficiente: el gate autoritativo es el pre-flight del paso 3) |
| 1.4 | `vergis-rollout prune --dry-run` | Qué retiraría la retención vigente. Que no te sorprenda **después** |
| 1.5 | El `CHANGELOG.md` de la versión candidata | ¿Trae una acción de migración? ¿Dice **«rompe rollback a < X.Y»**? Esa frase acorta tu ventana de reversión y hay que saberlo **antes** |
| 1.6 | Anota el estado del que vas a dejar atrás | Versión + digest del activo actual. Es el destino de tu rollback, y se escribe **antes**, no durante la emergencia |

**Si 1.2 no está sano, para acá.** Promover sobre un punto de partida degradado hace que después no
se pueda saber qué rompió qué.

## 2 · Instalar el anillo (no toca el tráfico)

```sh
vergis-rollout install <versión>          # pull + digest + create + start; queda EN ESPERA
```

**Verificación:** `vergis-rollout status` muestra el anillo nuevo **en espera**, con el digest que
resolvió el `pull`. Un anillo que no llega a responder **no queda marcado como promovible** — y eso
es un resultado, no un error de la herramienta.

**Rollback de este paso:** `vergis-rollout retire <versión> --rmi`. Nada del tráfico se movió.

**Si el guard de digest se niega** (la versión ya está registrada con otro digest): **no lo fuerces
por inercia**. Dos imágenes distintas con el mismo número de versión es un hecho medido en este
proyecto, y el digest es lo único que las distingue. Averigua cuál de las dos es la que quieres;
`--redigest` instala la nueva **aparte** (`<versión>-r2`) sin pisar la anterior.

## 3 · Arrancar el poller y su bitácora

Arranca el poller (§0) y **déjalo corriendo**. Dos requisitos que se cumplen acá o no se cumplen:

- El control negativo **ya se corrió** al menos una vez en esta instalación (§0.4).
- La primera línea del log queda **antes** del acto: sin baseline no hay intervalo que medir.

## 4 · Promover

```sh
vergis-rollout promote <versión>
```

La herramienta hace, en orden: **pre-flight** → **handover del plano de control** → **flip del
borde** → **smoke** → **registro**. Qué verificar en cada uno:

| Paso | Verificación | Si falla |
|--|--|--|
| **Pre-flight** | El candidato corre la imagen registrada, responde, y su `/contrato` declara que soporta el esquema del archivo de **cada** store | **No se tocó nada.** Un pre-flight que no logra medir **se niega**: sin `RINGS_ADMIN_EMAIL` no puede leer `/contrato` y aborta. Eso es correcto, no un obstáculo que saltar |
| **Handover** | El candidato declara `serving`; el anterior queda **en espera y sigue sirviendo lecturas** | El control vuelve al anterior y **el tráfico jamás se movió**. Si el mensaje dice que hay **cero** controladores, eso sí es un incidente: ve a §6 |
| **Flip** | `active.caddy` apunta al anillo nuevo; la config **se validó** antes de recargar | Una config inválida restaura la línea anterior y **no** recarga. El borde sigue con lo que tenía |
| **Smoke** | Por el borde, con el predicado completo | La herramienta **vuelve atrás** por el mismo camino. Confírmalo con `status` y con el poller, no con el mensaje en pantalla |
| **Registro** | `vergis-rollout status`: el nuevo activo, el anterior como **previo** (caliente) | Si el registro y la realidad no coinciden, **para y reporta lo observado** — no «corrijas» sobre una lectura no confirmada |

**El costo honesto, y hay que decirlo antes de que alguien lo note:** entre el handover y el `serving`
del candidato (segundos) las **escrituras** responden **409 explícitos**; las **lecturas se sirven
todo el tiempo** y el serving no se interrumpe. Si en esa ventana hay gente guardando cambios, verá
un conflicto claro y podrá reintentar — no un error crudo ni un guardado que se perdió.

## 5 · Después (esto es la parte que se olvida)

1. **Detén el poller y lee su log.** Cuenta las líneas `NO-SERVIDA`. Ese número —y el intervalo
   entre la primera y la última— **es** tu corte. No el tiempo que tardó el comando.
2. **Verifica lo funcional, no solo el healthz.** Abre el índice y **al menos un PI de cada dominio**
   con una identidad real: el smoke de la herramienta verifica el predicado de salud y el índice, no
   la ruta de cada PI (`/healthz` publica **conteos**, no slugs).
3. **Registra la fila**, en el registro de cortes de tu instancia: fecha, acto, versión de origen y
   destino con digests, corte medido, PIs afectados, instrumento usado y **si el control negativo se
   corrió**. Si no se pudo medir, **la fila va igual** diciendo «sin medir» y por qué: una fila
   ausente hace creer que el corte no ocurrió.
4. **Deja el previo caliente.** Es la red del rollback en caliente y no cuesta nada tenerla puesta.
   `prune` no lo retira ni con `--force`.

## 6 · Volver atrás

### Al previo (caliente) — el caso normal

```sh
vergis-rollout rollback          # flip puro: el previo ya está caliente
```

Mismo pre-flight, mismo smoke, mismo poller corriendo. **Sube el poller también para el rollback:**
la maniobra de emergencia es exactamente donde más cara sale una medición que no se hizo.

### A un anillo retenido (frío)

```sh
vergis-rollout rollback <versión>   # lo arranca primero
```

El arranque cuesta **segundos** (3,8–11,6 s medidos para un arranque de nodo, con dispersión no
explicada) y la sala de espera lo convierte en **latencia retenida**, no en error. Es un acto anormal
y deliberado: verifica antes el label `vergis.schema.stores` de esa imagen (§1.3) contra lo que
`/contrato` declara del archivo. Si el `CHANGELOG` de alguna versión intermedia dice «rompe rollback
a < X.Y», **ese es el piso** y el pre-flight se va a negar.

### Si hay CERO controladores

Es la dirección segura del diseño —falla hacia cero, nunca hacia dos— pero es un incidente: nadie
observa, nadie reconcilia, nadie consume cargas. Las lecturas siguen sirviéndose.

1. `vergis-rollout status` y el bloque `control` de `/contrato` de cada anillo caliente: quién cree
   ser el titular, con qué época.
2. **No borres el archivo de lease a mano** para «desatascar». El relevo por staleness converge solo;
   borrarlo es abrir la puerta a dos controladores, que es la única falla que este diseño trata como
   inaceptable.
3. Si el motivo es un candidato que no arranca: `rollback` al previo, que sigue caliente.

### Lo que un rollback NO hace, nunca

**No** borra ni «restaura» stores. Los datos van hacia adelante: volver de versión no devuelve el
archivo a como estaba, y restaurar un respaldo pre-migración **perdería las escrituras posteriores**.
Esos respaldos los toca **solo un humano**, con la decisión tomada de frente y a sabiendas de qué se
pierde.

---

## Límites declarados

- **Un solo host, con FS local.** El plano de control se ordena por **rename atómico** y por relojes
  del **mismo kernel**: dos anillos coordinan porque comparten ambos. Un **volumen de red** (NFS,
  SMB, CIFS, EFS…) o dos hosts con relojes desfasados quedan **fuera de contrato** — no está
  soportado, no está medido y el modo de falla que habilita (dos nodos creyéndose el activo) es
  justamente el que todo este mecanismo existe para hacer imposible. Si tu `VERGIS_OUT` no es un
  volumen local del host donde corren los anillos, **este mecanismo no aplica a tu instalación**.
- La **sala de espera no cubre la muerte del propio borde** (residual: `restart: unless-stopped` del
  contenedor de Caddy — y ese corte sí es corte).
- El **smoke no recorre las rutas de cada PI**: `/healthz` publica conteos, no slugs. El invariante
  que sí se exige es `pis.serving == pis.total`, y lo funcional lo verifica un humano (§5.2).
- **`ring.args` es un espejo manual** del servicio `vergis` del compose. Nada verifica que estén
  sincronizados: si cambias un env o un montaje en uno, cámbialo en el otro.
- **El handover tiene una carrera declarada**: quien suelta el control no nombra sucesor, así que
  cualquier anillo caliente puede tomarlo. La herramienta converge insistiendo y lo dice en pantalla
  mientras lo hace.

## Lo medido y lo que NO

**Medido** (e2e local, host de desarrollo): el handover del plano de control, el flip del borde, el
gate de esquema negándose, la vuelta atrás cuando el smoke falla, y el modo de falla del inodo de
§0.5 — que salió como control negativo falso antes de entenderse.

**Lo que NO se promete: corte cero.** La promoción medida **no fue corte cero**. En el e2e del frente
anterior se observó un tramo de **≈1,9 s** en que el predicado `phase=serving` no se satisfacía, con
**0 PIs servidos** y **cero respuestas de error crudas** en el poller. Lo que el mecanismo elimina es
el **error** (502/404 y el `server-not-found` del navegador) y el **recreate** con su ventana; lo que
deja es un tramo corto de escritura congelada con 409 explícitos. Mide **tu** corte en **tu**
instalación: el número de arriba viene de un host de desarrollo con 0 PIs y **no caracteriza** una
instalación con carga.

**Sin medir, y dicho como tal:** el ancho de la ventana de gracia frente a un candidato lento en
arrancar · el consumo de RAM de dos anillos calientes sirviendo una instancia con carga real · el
comportamiento sobre volumen de red (fuera de contrato) · el costo marginal en disco de un anillo
adicional cuando las capas base se comparten (`docker system df` lo dice en tu host, y conviene
mirarlo antes de subir `RINGS_RETAIN`).

---

• *Generado con Wingworking*
