---
description: Cambiar la versión DE Vergis que corre una instalación, por ANILLOS y en ambas direcciones; no publica nada EN la instalación: contenido, servicios, conexiones, políticas y specs son vergis:publish, vergis:setup, vergis:connect, custos:enforce y mira:specialize. Publicar una versión de Vergis (tag e imagen) no es de los plugins: es del mantenedor del Producto. La ceremonia completa — recon, qué exige la versión destino y todas las intermedias (leído del CHANGELOG), la herramienta de anillos extraída de la imagen candidata por digest, install, el poller de corte con su línea base y su control negativo (CN-1) obligatorios, promote o rollback, el corte contado por el poller y no por el comando, la fila en el registro de cortes y el previo caliente; además retire y prune de anillos, y los cambios de arranque que exigen anillo nuevo (ring-args). Usar SIEMPRE que se pida «despliega la X.Y.Z», «sube a la X.Y.Z», «actualiza a la X.Y.Z», «promueve la X.Y.Z», «instala la versión», «upgrade», «vuelve atrás», «rollback», «¿qué versión corre?», «estado de los anillos», «retira el anillo», «poda los anillos», «cambia una variable de arranque», o haya que medir una promoción o decidir si un anillo está sano.
argument-hint: "<acto: status|install|promote|rollback|retire|prune|ring-args> [<versión>] [--installation <id>]"
---

# vergis:rollout — cambiar la versión de Vergis por anillos, con el corte medido

**Vocabulario.** *Rollout* es el acto y su mecanismo: cambiar la versión **DE** Vergis que corre la instalación, hacia adelante o hacia atrás, por anillos. Es el mismo nombre del verbo del CLI (`vergis-ops exec rollout …`), de `deploy/rollout/` y del label `vergis.rollout.sha256` de la imagen. Lo que se publica **EN** la instalación (contenido, servicios, conexiones, políticas, specs) no es rollout: tiene su skill.

**Fuente canónica:** el README y el RUNBOOK de anillos **de la versión que corre la instalación** — `https://github.com/Gegolabs/vergis/blob/v<versión>/deploy/rollout/README.md` y `https://github.com/Gegolabs/vergis/blob/v<versión>/deploy/rollout/RUNBOOK.md`, con `<versión>` la del anillo activo (no viajan en la imagen: se leen del repo del Producto en su tag). Ante una contradicción, gana ese RUNBOOK. Esta skill los convierte en pasos; el CLI convierte en **construcción** lo que el RUNBOOK exige: `promote` y `rollback` **se niegan** sin poller corriendo, sin línea base y sin un CN-1 rojo-como-debe contra el anillo destino. Así «promoción verificada» no es una disciplina: es la única forma de promover.

El CLI es `vergis-ops`. El sombrero es de **operador** (ver `vergis:setup`): sin `vergis-ops.json` el CLI se niega, y con más de una instalación todo verbo lleva `--installation <id>`.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## ¿Qué gate tiene cada verbo?

Todos los verbos de la ceremonia que **tocan el host** son actos de clase **`version`**, y pasan por el gate que la instalación declara para esa clase (`governance.gates.version`): `install`, `promote`, `rollback`, `retire`, `prune` (salvo `--dry-run`, que es `read`), `tool`, `ring-args --apply` (sin `--apply` es `read`), y `poller cn1` **cuando arranca un anillo retenido**. **Si la instalación no declara gate para `version`, rige `approval`**: lo que nadie clasificó sigue pidiendo aprobación. La evidencia va en la misma línea del verbo:

```sh
vergis-ops exec rollout promote 1.4.0 --approval "<quién · cuándo · sus palabras>"     # gate approval
vergis-ops exec rollout promote 1.4.0 --impact "<qué cae y por cuánto>" --window "<quién · cuándo · sus palabras>"   # gate window
```

Con `operator` (lo típico en GA para lo que no corta: una promoción por anillos no corta) no se pide nada: la red la pone quien ejecuta. Nunca se escribe una evidencia que no existe.

## ¿Qué decide que un anillo está sano?

```
HTTP 200  ∧  "phase":"serving"  ∧  lets.serving == lets.total
```

**Nunca «responde», nunca `r.ok`, nunca «2xx».** Un nodo **en espera** responde 200 con `ok:true` por diseño: sirve lecturas, no tiene el plano de control, sus escrituras dan 409. Fases: `starting` (503) → `standby` (sano, no controla) → `degraded` (sirve N de M) → `serving`. Es el mismo predicado en el borde, en `botler-rollout` y en el poller. Un nodo anterior a 0.27.0 dice `pis` en vez de `lets`: el poller y `vergis-ops health` lo leen igual y **dicen** cuál leyeron.

## La ceremonia

### 0 · Recon, sin tocar nada

```sh
vergis-ops recon
vergis-ops exec rollout status          # activo, previo, borde, fase viva de cada anillo
```

- **Anota el activo y su digest ANTES**: es el destino de tu rollback, y se escribe antes, no durante la emergencia.
- `vergis-ops exec rollout prune --dry-run`: que la retención no te sorprenda después.
- `vergis-ops exec rollout ring-args`: si el compose cambió y `ring.args` no se regeneró, el anillo nuevo nacería con otro contrato. Con drift, `--apply` lo regenera con respaldo (los anillos vivos no cambian).

### 1 · ¿Qué exige la versión? — antes del `pull`

Lee el `CHANGELOG.md` de la versión destino **y de todas las intermedias**: se salta de la que corre la instalación a la nueva, no de la anterior a la nueva, y es en las intermedias donde muerde. Dilo en voz alta antes de tocar el host:

1. **¿Rompe un contrato?** (un campo retirado, una clave que cambia de forma).
2. **¿Trae una fase o un campo que alguien consuma?** (un health check, un poller, un script de la instalación).
3. **¿Hay migración o variable nueva** que haga falta para obtener el efecto?
4. **¿Dice «rompe rollback a < X.Y»?** Esa frase acorta tu ventana de reversión: sábelo **antes**.

Si las cuatro son «nada», se dice y se sigue. El CHANGELOG se lee del repo del Producto **en el tag**, o de la imagen (`docker run --rm --entrypoint cat <imagen:v> /app/CHANGELOG.md`). Los labels de esquema de la candidata (`docker image inspect … vergis.schema.stores`) descartan un rollback incompatible sin arrancar nada.

### 2 · La herramienta de la versión — siempre

Antes de instalar, **siempre**, la herramienta de la candidata, **desde su imagen** (no depende de que el CHANGELOG diga que cambió):

```sh
vergis-ops exec rollout tool <versión>     # pull, digest, extrae /app/deploy/rollout/, verifica el sha contra
                                   # el label vergis.rollout.sha256 y la instala con respaldo
```

Herramienta y nodo quedan siendo el mismo objeto, y `install` **lo coteja**: si el sha de `botler-rollout` del host no es el del label de la candidata, se niega (2) y nombra este paso. La única excepción es instalar una versión **anterior** con la herramienta más nueva (`--keep-tool`: la herramienta no retrocede). Una imagen anterior a que la herramienta viajara adentro no trae el label: para esas no hay cotejo, y la herramienta sale del repo del Producto **en su tag**, nunca de un clon en otra rama.

### 3 · Instalar (no toca el tráfico)

```sh
vergis-ops exec rollout install <versión exacta>
```

**Nunca un tag móvil** (`latest`, `main`, una serie): no identifica lo que quedaría corriendo. Queda en espera, verificado. Si el **guard de digest** se niega (la versión ya está registrada con otro digest), **no lo fuerces por inercia**: dos imágenes con el mismo número es un hecho que ya ocurrió; averigua cuál es la buena. Rollback de este paso: `vergis-ops exec rollout retire <versión> --rmi`.

### 4 · El instrumento, ANTES del acto

```sh
vergis-ops poller start                          # en el borde (o en instrument.container), por el conmutador
vergis-ops poller cn1 --ring <versión destino>   # el mismo poller contra el anillo en espera: TODO MAL phase=standby
```

- **El poller vive en un contenedor que el acto no recrea.** Uno efímero muere durante el acto y acota el corte por abajo, sin decir que no pudo medir.
- **El control negativo es obligatorio.** Si el CN-1 sale con alguna muestra OK, el instrumento está ciego: no se promueve con él. Si sale verde entero contra un standby, sospecha del **transporte** antes que del mecanismo (¿el poller apuntó adonde creías?).
- **Línea base** de `instrument.baseline_seconds` (60 por omisión) antes del acto: sin baseline no hay intervalo que medir.
- **El CN-1 caduca a los 30 minutos**: `promote` y `rollback` exigen uno contra el destino tomado en la última media hora. Si el acto se demora, se repite el CN-1 — el instrumento se prueba antes del acto, no de memoria.
- Un cuerpo vacío o no-JSON es `MAL`; sin respuesta HTTP en el timeout es `SINMEDIR`, que se cuenta aparte. «No pude medir» nunca es verde — y tampoco es «corte».
- **Cada muestra lleva su latencia** (`ms=`) y el timeout es de **10 s** por omisión (`poller start --timeout s`): la sala de espera **retiene** requests durante el relevo, y una retención es un OK lento, no un «no pude medir» (#367). La cuenta dice la latencia OK máxima y cuántas OK pasaron de 2 s.
- **Dónde puede vivir:** un contenedor con `sh` y las herramientas de `poller.sh` (`wget`, `sed`…), o uno que traiga solo `node` ≥ 18 — ahí corre su hermano `poller-node.mjs`, con la misma línea y el mismo predicado (#376). `vergis-ops check` lo sondea en el host antes del acto y nombra lo que falta.

### 5 · Promover

```sh
vergis-ops exec rollout promote <versión>
```

La herramienta hace, en orden: pre-flight (el candidato corre la imagen registrada y su `/contrato` declara soportar el esquema de **cada** store; el borde valida su config) → intent de handover → **flip del borde** → handover del plano de control → smoke por el borde → registro. El flip va antes a propósito: lo que entra mientras el candidato aún no sirve queda **retenido** en la sala de espera, no respondido con error. Si el pre-flight no logra medir, **se niega** y no se tocó nada.

El CLI espera un cierre (`--tail`, 10 s) con el poller corriendo y **cuenta el corte**. El costo honesto: en el relevo, las **escrituras** responden 409 explícitos por segundos; las lecturas se sirven todo el tiempo.

### 6 · Después — la parte que se olvida

1. `vergis-ops poller stop` — la cuenta final. **Ese número es el corte, no la duración del comando** (el comando miente: un `restart` devuelve en milisegundos mientras las rutas no sirven por segundos).
2. **vergis:verify**: salud, que cada Let responda en todas sus vistas, y la paridad; si la instalación gobierna el dato o sirve PIs de Mira, además **custos:verify** (RLS por identidad) y **mira:status** (vistas, drills y marcas). El smoke de la herramienta mira conteos, no rutas.
3. **La fila** en `governance.cuts_log`: fecha, acto, origen → destino con digests, corte medido, instrumento y versión, si corrió el CN-1. Si no se pudo medir, la fila va igual diciendo «sin medir» y por qué.
   - **La fila separa** `fuera de predicado` (las `MAL`: ESE es el corte) de `sin medir` (las `SINMEDIR`: sin respuesta HTTP en el timeout), y lleva la latencia OK máxima y el timeout del poller. Una muestra retenida por la sala de espera (máximo medido en producción: 2.011 ms) sale OK con su `ms=`, no `SINMEDIR` (#367).
4. **Deja el previo caliente**: es la red del rollback y no cuesta nada.

## Volver atrás

```sh
# al previo (caliente): flip puro
vergis-ops poller start && vergis-ops poller cn1 --ring <versión previa>    # sí: también para el rollback
vergis-ops exec rollout rollback

# a un retenido (frío): el CN-1 lo arranca, espera su standby, y recién mide
vergis-ops poller start && vergis-ops poller cn1 --ring <versión retenida>
vergis-ops exec rollout rollback <versión retenida>
```

- La maniobra de emergencia es donde más cara sale una medición que no se hizo: **mismo instrumento**.
- **A un retenido frío**: contra un contenedor detenido no hay control negativo posible (el poller no obtiene respuesta), así que `poller cn1` **lo arranca** —un acto de clase `version`, con el mismo gate que `install`— y espera a que declare `phase=standby` por la misma ruta que va a medir (`--standby-timeout`, 90 s por omisión). El arranque de un nodo cuesta segundos y ocurre **antes** del acto, fuera del tráfico. El anillo queda caliente: es el candidato. **Si no sigues con el rollback, devuélvelo tú a retenido** — `vergis-ops exec run --class version -- 'docker stop <anillo>'` —, porque vivo es un tercer aspirante al lease; la próxima promoción también lo haría, pero puede no haber una pronto. Si no llega a standby, el CN-1 **lo vuelve a detener él mismo** (lo arrancó él), sale 1 y el rollback no corre: el previo caliente sigue siendo la red. Un anillo que ya corría antes del CN-1 no se toca.
- A un retenido frío, además: verifica antes su label de esquema; si un CHANGELOG intermedio dice «rompe rollback a < X.Y», ese es el piso y el pre-flight se va a negar.
- **Cero controladores** (nadie tiene el plano de control): es la dirección segura del diseño, pero es un incidente. `vergis-ops exec rollout status` y el bloque `control` de `/contrato` de cada anillo. **No borres el lease** para «desatascar»: el relevo converge solo, y borrarlo abre la puerta a dos controladores. Si el candidato no arranca, rollback al previo.
- **Un rollback jamás restaura stores.** Los datos van hacia adelante; un respaldo pre-migración lo toca solo un humano sabiendo qué escrituras pierde.

## Retirar y podar anillos

```sh
vergis-ops exec rollout retire <versión> [--rmi]              # un anillo, por versión exacta
vergis-ops exec rollout prune --dry-run                       # qué retiraría la retención, sin tocar nada (read)
vergis-ops exec rollout prune [--retain N] [--rmi]            # conserva los N más recientes
```

- Son actos de clase **`version`**, con el gate que la instalación declara para esa clase; `prune --dry-run` es `read`. `--rmi` borra además la imagen del anillo retirado: sin ella, volver a esa versión exige otro `pull` y otra herramienta.
- **El activo y el previo se conservan siempre**, con cualquier combinación de flags: la herramienta no los retira, y ninguna skill lo intenta. El previo es la red del rollback.
- `retire <versión> --rmi` es también el rollback de un `install` que no se va a promover (§3).
- Antes de podar, `prune --dry-run`: que la retención no se lleve un retenido que era tu piso de rollback (un CHANGELOG intermedio que diga «rompe rollback a < X.Y» lo vuelve el único destino posible).

## Cambios de arranque que exigen anillo nuevo

Una variable o un montaje que el nodo lee al arrancar, y que **cada anillo** lleva en su `ring.args`, no se cambia en el anillo vivo: entra en un anillo nuevo y se promueve con esta misma ceremonia. `vergis-ops contract env <VARIABLE>` lo dice (`version`: anillo nuevo). Lo que comparten todos los anillos (como `VERGIS_OUT` o el lease) no entra por aquí: es `boot` de verdad, con corte y ventana (`vergis:setup` §`boot`).

1. El cambio en el **espejo** del compose, commiteado, y publicado con `vergis:setup` (`vergis-ops publish <compose>`): el compose es de la instalación, y el anillo nuevo nace de él.
2. `vergis-ops exec rollout ring-args` (sin `--apply`, `read`) muestra el drift entre el compose vivo y `ring.args`; `--apply` lo regenera con respaldo. Los anillos vivos no cambian.
3. `vergis-ops exec rollout install <ref>` con un ref que **no** sea el del activo: la versión siguiente, o el **mismo código** bajo su `sha-<commit>` (`install` es idempotente por versión: re-instalar la que corre no crea un anillo nuevo). Verifica en el `/contrato` del anillo nuevo que la variable está como esperas, y sigue la ceremonia desde §4: poller, CN-1 contra el anillo nuevo, `promote`, corte medido, fila. El rollback vuelve al anillo anterior **con la configuración anterior**: es la reversa del cambio.
4. Lee antes el **RUNBOOK §7 «Cambiar la configuración de arranque con anillos»** de la versión que corre la instalación: ante una contradicción, gana el RUNBOOK.

Ejemplos de esta clase: encender la generación del datadoc en el nodo (`VERGIS_DATADOC`, `VERGIS_WRITERS` y el montaje de su archivo), o un Conector que la instalación declara inline en `VERGIS_CONNECTIONS` (`vergis:connect`).

## Lo que ninguna flag habilita

Editar `ring.args` o `active.caddy` a mano · borrar o editar el lease · `docker compose down -v` · promover sin instrumento · `--no-schema-gate` desde el plugin (existe para instancias **sin** bloque de gobierno, y esa decisión se toma a mano, con la herramienta, gritándola en pantalla) · retirar el activo o el previo.

## Límites declarados (del Producto)

Un solo host con FS local (el lease se ordena por rename atómico y el reloj del mismo kernel; un volumen de red queda fuera de contrato) · la sala de espera no cubre la muerte del propio borde · el smoke de la herramienta no recorre rutas · el intent de handover **ordena la fila, no otorga el control** · la RAM de dos anillos calientes con carga real no está medida en general.

• *Generado con Wingworking*
