---
description: Promover, instalar o volver atrás una versión del Producto en una instalación de Vergis por ANILLOS, con la ceremonia completa — recon, qué exige la versión destino y todas las intermedias (leído del CHANGELOG), la herramienta de anillos extraída de la imagen candidata por digest, install, el poller de corte con su línea base y su control negativo (CN-1) obligatorios, promote, el corte contado por el poller y no por el comando, la fila en el registro de cortes y el previo caliente. Usar SIEMPRE que se pida «promueve la X.Y.Z», «instala la versión», «sube la versión nueva», «vuelve atrás», «rollback», «¿qué versión corre?», «estado de los anillos», o haya que medir una promoción o decidir si un anillo está sano. Para publicar contenido o tocar servicios, vergis:ops.
argument-hint: "<acto: status|install|promote|rollback> [<versión>] [--installation <id>]"
---

# vergis:rollout — promover y volver atrás por anillos, con el corte medido

**Fuente canónica:** `deploy/rollout/README.md` y `deploy/rollout/RUNBOOK.md` **de la versión que corre la instalación** (ante una contradicción, gana ese RUNBOOK). Esta skill los convierte en pasos; el CLI convierte en **construcción** lo que el RUNBOOK exige: `promote` y `rollback` **se niegan** sin poller corriendo, sin línea base y sin un CN-1 rojo-como-debe contra el anillo destino. Así «promoción verificada» no es una disciplina: es la única forma de promover.

El CLI es `node ${CLAUDE_PLUGIN_ROOT}/bin/vergis-ops.mjs` (abajo, **`vo`**). El sombrero es de **operador** (ver vergis:ops).

## ¿Qué decide que un anillo está sano?

```
HTTP 200  ∧  "phase":"serving"  ∧  lets.serving == lets.total
```

**Nunca «responde», nunca `r.ok`, nunca «2xx».** Un nodo **en espera** responde 200 con `ok:true` por diseño: sirve lecturas, no tiene el plano de control, sus escrituras dan 409. Fases: `starting` (503) → `standby` (sano, no controla) → `degraded` (sirve N de M) → `serving`. Es el mismo predicado en el borde, en `botler-rollout` y en el poller. Un nodo anterior a 0.27.0 dice `pis` en vez de `lets`: el poller y `vo health` lo leen igual y **dicen** cuál leyeron.

## La ceremonia

### 0 · Recon, sin tocar nada

```sh
vo recon
vo exec rollout status          # activo, previo, borde, fase viva de cada anillo
```

- **Anota el activo y su digest ANTES**: es el destino de tu rollback, y se escribe antes, no durante la emergencia.
- `vo exec rollout prune --dry-run`: que la retención no te sorprenda después.
- `vo exec rollout ring-args`: si el compose cambió y `ring.args` no se regeneró, el anillo nuevo nacería con otro contrato. Con drift, `--apply` lo regenera con respaldo (los anillos vivos no cambian).

### 1 · ¿Qué exige la versión? — antes del `pull`

Lee el `CHANGELOG.md` de la versión destino **y de todas las intermedias**: se salta de la que corre la instalación a la nueva, no de la anterior a la nueva, y es en las intermedias donde muerde. Dilo en voz alta antes de tocar el host:

1. **¿Rompe un contrato?** (un campo retirado, una clave que cambia de forma).
2. **¿Trae una fase o un campo que alguien consuma?** (un health check, un poller, un script de la instalación).
3. **¿Hay migración o variable nueva** que haga falta para obtener el efecto?
4. **¿Dice «rompe rollback a < X.Y»?** Esa frase acorta tu ventana de reversión: sábelo **antes**.

Si las cuatro son «nada», se dice y se sigue. El CHANGELOG se lee del repo del Producto **en el tag**, o de la imagen (`docker run --rm --entrypoint cat <imagen:v> /app/CHANGELOG.md`). Los labels de esquema de la candidata (`docker image inspect … vergis.schema.stores`) descartan un rollback incompatible sin arrancar nada.

### 2 · La herramienta de la versión

Si el CHANGELOG dice que cambió el contrato del nodo o de la herramienta, instálala **desde la imagen candidata**:

```sh
vo exec rollout tool <versión>     # pull, digest, extrae /app/deploy/rollout/, verifica el sha contra
                                   # el label vergis.rollout.sha256 y la instala con respaldo
```

Herramienta y nodo quedan siendo el mismo objeto. Una imagen anterior a que la herramienta viajara adentro no trae el label: para esas, la herramienta sale del repo del Producto **en su tag**, nunca de un clon en otra rama.

### 3 · Instalar (no toca el tráfico)

```sh
vo exec rollout install <versión exacta>
```

**Nunca un tag móvil** (`latest`, `main`, una serie): no identifica lo que quedaría corriendo. Queda en espera, verificado. Si el **guard de digest** se niega (la versión ya está registrada con otro digest), **no lo fuerces por inercia**: dos imágenes con el mismo número es un hecho que ya ocurrió; averigua cuál es la buena. Rollback de este paso: `vo exec rollout retire <versión> --rmi`.

### 4 · El instrumento, ANTES del acto

```sh
vo poller start                          # en el borde (o en instrument.container), por el conmutador
vo poller cn1 --ring <versión destino>   # el mismo poller contra el anillo en espera: TODO MAL phase=standby
```

- **El poller vive en un contenedor que el acto no recrea.** Uno efímero muere durante el acto y acota el corte por abajo, sin decir que no pudo medir.
- **El control negativo es obligatorio.** Si el CN-1 sale con alguna muestra OK, el instrumento está ciego: no se promueve con él. Si sale verde entero contra un standby, sospecha del **transporte** antes que del mecanismo (¿el poller apuntó adonde creías?).
- **Línea base** de `instrument.baseline_seconds` (60 por omisión) antes del acto: sin baseline no hay intervalo que medir.
- Un cuerpo vacío o no-JSON es `MAL`; sin respuesta HTTP es `SINMEDIR`, que se cuenta aparte. «No pude medir» nunca es verde.

### 5 · Promover

```sh
vo exec rollout promote <versión>
```

La herramienta hace, en orden: pre-flight (el candidato corre la imagen registrada y su `/contrato` declara soportar el esquema de **cada** store; el borde valida su config) → intent de handover → **flip del borde** → handover del plano de control → smoke por el borde → registro. El flip va antes a propósito: lo que entra mientras el candidato aún no sirve queda **retenido** en la sala de espera, no respondido con error. Si el pre-flight no logra medir, **se niega** y no se tocó nada.

El CLI espera un cierre (`--tail`, 10 s) con el poller corriendo y **cuenta el corte**. El costo honesto: en el relevo, las **escrituras** responden 409 explícitos por segundos; las lecturas se sirven todo el tiempo.

### 6 · Después — la parte que se olvida

1. `vo poller stop` — la cuenta final. **Ese número es el corte, no la duración del comando** (el comando miente: un `restart` devuelve en milisegundos mientras las rutas no sirven por segundos).
2. **vergis:verify**: smoke de todos los Lets y todas las vistas, y la paridad. El smoke de la herramienta mira conteos, no rutas.
3. **La fila** en `governance.cuts_log`: fecha, acto, origen → destino con digests, corte medido, instrumento y versión, si corrió el CN-1. Si no se pudo medir, la fila va igual diciendo «sin medir» y por qué.
4. **Deja el previo caliente**: es la red del rollback y no cuesta nada.

## Volver atrás

```sh
# al previo (caliente): flip puro
vo poller start && vo poller cn1 --ring <versión previa>    # sí: también para el rollback
vo exec rollout rollback

# a un retenido (frío): el CN-1 lo arranca, espera su standby, y recién mide
vo poller start && vo poller cn1 --ring <versión retenida>
vo exec rollout rollback <versión retenida>
```

- La maniobra de emergencia es donde más cara sale una medición que no se hizo: **mismo instrumento**.
- **A un retenido frío**: contra un contenedor detenido no hay control negativo posible (el poller no obtiene respuesta), así que `poller cn1` **lo arranca** —un acto de clase `version`, con el mismo gate que `install`— y espera a que declare `phase=standby` por la misma ruta que va a medir (`--standby-timeout`, 90 s por omisión). El arranque de un nodo cuesta segundos y ocurre **antes** del acto, fuera del tráfico. El anillo queda caliente: es el candidato; si no sigues, la próxima promoción lo devuelve a retenido. Si no llega a standby, el CN-1 sale 1 y el rollback no corre: el previo caliente sigue siendo la red.
- A un retenido frío, además: verifica antes su label de esquema; si un CHANGELOG intermedio dice «rompe rollback a < X.Y», ese es el piso y el pre-flight se va a negar.
- **Cero controladores** (nadie tiene el plano de control): es la dirección segura del diseño, pero es un incidente. `vo exec rollout status` y el bloque `control` de `/contrato` de cada anillo. **No borres el lease** para «desatascar»: el relevo converge solo, y borrarlo abre la puerta a dos controladores. Si el candidato no arranca, rollback al previo.
- **Un rollback jamás restaura stores.** Los datos van hacia adelante; un respaldo pre-migración lo toca solo un humano sabiendo qué escrituras pierde.

## Lo que ninguna flag habilita

Editar `ring.args` o `active.caddy` a mano · borrar o editar el lease · `docker compose down -v` · promover sin instrumento · `--no-schema-gate` desde el plugin (existe para instancias **sin** bloque de gobierno, y esa decisión se toma a mano, con la herramienta, gritándola en pantalla) · retirar el activo o el previo.

## Límites declarados (del Producto)

Un solo host con FS local (el lease se ordena por rename atómico y el reloj del mismo kernel; un volumen de red queda fuera de contrato) · la sala de espera no cubre la muerte del propio borde · el smoke de la herramienta no recorre rutas · el intent de handover **ordena la fila, no otorga el control** · la RAM de dos anillos calientes con carga real no está medida en general.

• *Generado con Wingworking*
