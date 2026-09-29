---
description: Operar una instalación de Vergis con el sombrero de operador — resolver la instalación declarada en vergis-ops.json, correr el recon, CLASIFICAR el acto contra el contrato vivo del nodo (content · boot · service · service-interrupting · destructive), aplicar el gate que la instalación declara para esa clase, ejecutar el flujo de la clase con respaldo, verificación medida y rollback escrito, y dejar el registro. Usar SIEMPRE que haya que desplegar o publicar algo en una instalación de Vergis — subir o actualizar un spec, una policy o cualquier archivo del espejo, cambiar el compose, el borde o un servicio, recargar o recrear un contenedor, cambiar una variable de arranque — o cuando se pida «despliega», «sube el spec», «aplica la policy», «cambia el compose», «recarga el borde», «publica el instrumento». Para promover o volver atrás una versión del Producto, vergis:rollout; para verificar, vergis:verify; para declarar la instalación, vergis:setup.
argument-hint: "<qué se quiere cambiar> [--installation <id>]"
---

# vergis:ops — operar una instalación de Vergis

**Esta skill se ejecuta con el sombrero de OPERADOR.** El Producto publica una versión con su changelog; qué corre una instalación, cuándo entra y bajo qué control de cambio lo decide quien la opera. **El sombrero lo decide la declaración, no el repo:** el CLI busca `vergis-ops.json` subiendo desde el directorio de trabajo, y sin él **se niega** a tocar una instalación. Si la sesión está en el repo del Producto y no hay declaración, lo que corresponde es publicar y avisar, no operar.

El CLI es `node ${CLAUDE_PLUGIN_ROOT}/bin/vergis-ops.mjs` (Node ≥ 22, sin dependencias). Abajo se abrevia **`vo`**. Con más de una instalación declarada, todo verbo lleva `--installation <id>`: no hay instalación por omisión.

## ¿Qué dice cada código de salida?

Un solo vocabulario para todos los verbos. Lo que importa es no confundir **«medí y salió mal»** con **«no pude medir»**:

| Exit | Significa | Qué se hace |
|--|--|--|
| 0 | medí, sin hallazgo | seguir |
| 1 | medí, **hay hallazgo** (del terreno, no del instrumento) | reportarlo; no repararlo de paso |
| 2 | **no corrí**: uso, guardia, gate sin su evidencia, clave no declarada | leer el mensaje: dice qué falta |
| 3 | respuesta **cruzada** (llegó la salida de otra corrida) | no se entrega; serializar y reintentar |
| 4 | transporte **ocupado** (otro actor tiene el canal) | esperar y reintentar |
| 5 | remoto **mudo** (sin centinela) | **no hubo medición**: nada de eso es un veredicto |
| 6 | el transporte **falló** | revisar acceso, cuenta, red |
| 7 | medí **a medias** | lo no medido se lista; **no cuenta como OK** |

Un 3–7 **no es un verde**. Un «verificado» con uno de ellos es falso.

## Paso 0 · ¿Desde dónde parto?

```sh
vo check      # la declaración se puede usar (0 o 2; nombra el defecto)
vo recon      # check + health + contrato + anillos + paridad, sin tocar nada
```

- Un **drift previo** (paridad en 1) se **reporta antes de seguir**: desplegar encima mezcla el cambio propio con el ajeno.
- `recon` dice la distancia entre la versión del plugin y la del nodo. Es normal (lo posterior se lee del nodo), pero una actualización pendiente del plugin no debería pasar inadvertida.
- Si el punto de partida no está sano (health en 1), no es un despliegue: es un incidente.

## Paso 1 · ¿Qué clase de acto es?

**Lo que recarga en caliente se lee del NODO, jamás de una tabla de memoria.** Las reglas copiadas se pudren: una regla vieja de «reiniciar para que tome la tabla» ya hizo reiniciar una plataforma entera para publicar un solo spec, cuando el nodo lo recargaba solo.

```sh
vo contract classify <archivo del espejo>   # la clase, por qué, y el gate que le toca
vo contract env <VARIABLE>                  # ¿qué exige cambiarla? anillo nuevo (version) · boot si la comparten todos los anillos · nada
vo contract                                 # watches, envs de arranque, artefactos pendientes
```

| Clase | Qué es | Cómo se decide |
|--|--|--|
| `read` | mirar | — |
| `content` | contenido que el nodo recarga en caliente | un `watch` del contrato vivo cubre la ruta (en el nodo) |
| `boot` | lo que el nodo lee al arrancar | montado en el nodo y sin `watch`; **o sin contrato que responda** (ante la duda, corte) |
| `service` | un servicio de la instalación, sin corte | lo monta un servicio con `interrupting: false`; o nada vivo lo monta |
| `service-interrupting` | un servicio cuya recarga corta rutas servidas | `interrupting: true`, o un servicio que la declaración no describe |
| `version` | promover o volver atrás por anillos | → **vergis:rollout** |
| `destructive` | borrar datos, volúmenes, anillos | siempre explícito |

**El gate lo declara la instalación** (`governance.gates`), citando la norma que lo funda (`governance.source`); si la declaración y la norma difieren, **gana la norma** y la declaración se corrige. Una clase sin gate declarado pide **aprobación**.

| Gate | Qué exige | Cómo se da la evidencia |
|--|--|--|
| `free` | nada | — |
| `operator` | lo decide quien ejecuta, **con red**: respaldo, plan de reversa, verificación medida | el CLI respalda y verifica; tú registras |
| `window` | **ventana de mantenimiento** autorizada por quien la instalación nombra en `window_approver` (su operador: sabe qué usuarios dependen de ella ahora), el **impacto declarado antes** y el **corte medido** | `--impact "<qué Lets caen y por cuánto>"` · `--window "<quién · cuándo · sus palabras>"` · poller corriendo |
| `approval` | el OK explícito de `approver` | `--approval "<quién · cuándo · sus palabras>"` (y `--impact` si corta) |

En una plataforma en GA típica, **lo que no corta no pide permiso** (se despliega con red) y **lo que corta pide ventana**, no permiso para desplegar: la ventana solo tiene sentido si hay corte. Lo destructivo pide aprobación. La declaración de cada instalación dice cómo es la suya; la skill no lo supone.

**El plugin no puede obligar a que exista la aprobación humana: exige su evidencia y la registra.** Nunca se escribe una evidencia que no existe.

## Paso 2 · El flujo de cada clase

### `content` — un spec, una policy, cualquier contenido que el nodo recarga

1. `vo recon` (paso 0).
2. `vo contract classify <archivo>` → tiene que decir `content`. Si dice otra cosa, **no es este flujo**.
3. Si la instalación declara `governance.pretest`, correrlo y tener su evidencia (p. ej. el render local contra el dato real).
4. **Espejo primero:** el archivo está en el repo del operador y la fuente es él, no el host.
5. `vo publish <archivo> --pretest "<qué corriste y qué dio>"` — clasifica, aplica el gate, **respalda** (`<ruta>.bak-<ts>`), escribe **en sitio** (conserva inodo, dueño y modo: un montaje de archivo sigue el inodo), **verifica el sha** en el host y **espera a que el nodo lo tome** (`pending=false` con el sha local). Si el nodo no lo toma, sale 1 y **no dice «publicado»**.
6. `vo smoke` — **todos** los Lets, no solo el tocado (un cambio rompe colateralmente).
7. `vo parity --family <familia>` hasta 0.
8. El rollback que `publish` imprimió queda en tu reporte.

### `service` y `service-interrupting` — compose, borde, proxy de identidad, sidecars

1. Editar **el espejo** y commitearlo. Nunca editar el host a mano.
2. `vo publish <archivo>` (el compose o el archivo del servicio).
3. Si el servicio declara `prevalidate`: `vo exec service <nombre> prevalidate` (contenedor efímero; no toca el vivo).
4. `service-interrupting` en un gate `window`: declarar el impacto, tener la ventana autorizada, **arrancar el poller** (`vo poller start`, con su `vo poller cn1 --ring <anillo en espera>`) y recién entonces actuar.
5. `vo exec service <nombre> reload` (si declara recarga en caliente) o `recreate`. `reload` **compara lo que el contenedor VE** en cada montaje de archivo contra el host: un editor o un `sed -i` cambian el inodo y el contenedor sigue viendo lo viejo — recargar no es haber leído lo nuevo. Si sale 1 por eso, el camino es `recreate`, con su gate.
6. `vo poller stop` da el corte. **La fila va a `governance.cuts_log` aunque diga «sin medir», y por qué**: una fila ausente hace creer que el corte no ocurrió.
7. `vergis:verify`.

**El contenedor que aloja el poller no se recrea mientras el poller corra**: sería matar la medición a mitad de serie y dejar la fila del corte «sin medir». El CLI se niega (2), y lo averigua **en el host** (el contenedor donde corre el poller contra los del servicio), no en una clave declarada. **Por omisión el poller vive en el borde** (`RINGS_EDGE`), así que recrear el borde con su ventana exige **moverlo primero**: `instrument.container` en la declaración apuntando a otro contenedor de vida larga que ese acto no recree, `vo poller stop`, `vo poller start` (ya en el nuevo) con su CN-1, y recién entonces `recreate`. `vo check` dice de antemano qué servicio aloja el instrumento.

### `boot` — una variable de arranque, un montaje del nodo

Lee **`deploy/rollout/RUNBOOK.md` §«Cambiar la configuración de arranque con anillos»** de la versión que corre la instalación. En corto: con anillos, un cambio de arranque entra en un **anillo nuevo** creado desde `ring.args` regenerado (`vo exec rollout ring-args --apply`), y se promueve con la ceremonia de **vergis:rollout** — eso es un acto `version`, instrumentado. Lo que ese camino no cubre (lo que comparten todos los anillos, como `VERGIS_OUT` o el lease) es `boot` de verdad: corte, ventana y medición.

### `destructive`

Borrar datos, volúmenes o anillos: gate `approval` (o el que declare la instalación), con impacto declarado. **Hay actos que el plugin no ejecuta aunque se declaren**, porque son invariantes del Producto y no gates: `docker compose down -v` (borra volúmenes del borde), tocar el lease del plano de control (`control.lease.json`, `control.handover.json`), editar `ring.args` o `active.caddy` a mano. `vo exec run` los rechaza con 2.

### Datos y motor de datos

No son del Producto. Si la instalación declara `extensions.data`, esa skill atiende la carga, el DDL, la seguridad a nivel de fila en el motor, el terreno. Si no la declara: **«fuera del Producto: no cubierto por esta instalación»**, y se dice así.

## ¿Qué ve la sonda, y qué no?

`smoke`, `contract` y `marks` entran **por detrás del borde**, desde dentro del anillo, **forjando** la identidad (`X-Forwarded-Email`/`X-Forwarded-Groups`): las de `probe_identities`, o la admin de `RINGS_ADMIN_EMAIL` para `/contrato`. Eso mide el tramo del nodo —imagen, spec, gobierno, dato— y **no** el login real del borde: un verde es compatible con un SSO roto. Y es un privilegio que se ejerce en cada consulta: **solo es seguro donde el nodo no está expuesto sin borde**. Si una instalación expone el nodo directo, eso se reporta antes de sondear.

## ¿Dónde queda el registro?

- Cada acto con efecto: una entrada en `governance.acts_log` con qué se hizo, la clase, el gate y su evidencia, las mediciones con su exit y el rollback.
- Cada corte (o cada acto que pudo cortar): una fila en `governance.cuts_log`, con el instrumento, su versión, si corrió el CN-1, y el número — o «sin medir» y por qué.
- Si la instalación no declara dónde, la salida del CLI es el registro: se pega en el reporte.

## ¿Qué no hace esta skill?

- No promueve versiones (→ **vergis:rollout**). No verifica por su cuenta (→ **vergis:verify**).
- No decide gates: los lee. No inventa evidencia de una aprobación.
- No repara un drift de paso: lo reporta.
- No opera datos ni el motor de datos.
- No opera varias instalaciones a la vez: cada acto es sobre una.

• *Generado con Wingworking*
