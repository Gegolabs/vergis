---
description: Preparar y ajustar EN la instalación de Vergis su infraestructura —compose, borde, servicios anexos, el terreno de anillos— y su declaración vergis-ops.json; no publica contenido (vergis:publish), no declara Conectores (vergis:connect) y no cambia la versión DE Vergis que corre la instalación (vergis:rollout). La preparación única del RUNBOOK, instalar los plugins desde el marketplace del Producto, AUTORAR la declaración hasta que `vergis-ops check` salga 0, y los actos de clase service, service-interrupting y boot con respaldo, reversa, gate y, si cortan, ventana y corte medido. Es además donde vive el modelo de clases y gates que usan todas las skills que actúan. Usar cuando se instale Vergis por primera vez, se sume una instalación a un repo de operación, se pida «declara la instalación», «valida la declaración», «instala el plugin de vergis», «cambia el compose», «recarga el borde», «recrea el servicio», o un verbo de vergis-ops se niegue por falta de una clave de la declaración.
argument-hint: "[instalar | declarar | validar | <cambio de infraestructura>] [--installation <id>]"
---

# vergis:setup — preparar y ajustar la instalación

**Esta skill se ejecuta con el sombrero de OPERADOR.** El Producto publica una versión con su changelog; qué corre una instalación, cuándo entra y bajo qué control de cambio lo decide quien la opera. **El sombrero lo decide la declaración, no el repo:** el CLI busca `vergis-ops.json` subiendo desde el directorio de trabajo, y sin él **se niega** a tocar una instalación. Si la sesión está en el repo del Producto y no hay declaración, lo que corresponde es publicar y avisar, no operar. Con más de una instalación declarada, todo verbo lleva `--installation <id>`: no hay instalación por omisión.

**Lo que esta skill no hace:** crear infraestructura cloud, gastar, ni decidir la política de la instalación. Eso es del operador y de su gobierno. Deja el terreno listo para que las demás skills operen, deja escrito en la declaración lo que el operador ya decidió, y aplica los cambios de infraestructura que el operador pide.

**Salida del CLI:** 0 medí sin hallazgo · 1 medí y hay hallazgo · 2 no corrí (el mensaje dice qué falta) · 3 a 7 **no hubo medición completa** (respuesta cruzada, transporte ocupado, remoto mudo, transporte caído, medí a medias). Un 3–7 **no es un verde**. La tabla completa está en `vergis:verify`.

## ¿Qué hace falta en la estación del operador?

- **Node ≥ 22** como el `node` del `PATH` (el CLI es Node sin dependencias). Si falta, dilo y **detente**: nada de lo que sigue corre sin él.
- `git`, y Claude Code con plugins.
- El cliente del transporte de la instalación: `docker` local, `ssh` con llave, o `az` con sesión en la cuenta técnica.
- **Solo macOS o Linux, con la herramienta Bash de Claude Code.** Las skills de los plugins `vergis`, `custos` y `mira` invocan el CLI como **`vergis-ops`**: Claude Code pone el `bin/` de un plugin habilitado en el `PATH` de la herramienta Bash, y `bin/vergis-ops` carga el CLI con `#!/usr/bin/env node`. Eso no funciona en Windows (issue anthropics/claude-code#68896). Comprobación: `command -v vergis-ops` tiene que encontrarlo; si no, el plugin `vergis` no está habilitado en la sesión (instalar `custos` o `mira` lo instala como dependencia, pero tiene que quedar habilitado).

## 1 · La instancia (una vez, si es nueva)

Sigue el README de anillos §«Preparar la instancia» **de la versión que se va a instalar** (`https://github.com/Gegolabs/vergis/blob/v<versión>/deploy/rollout/README.md`: el README y el RUNBOOK no viajan en la imagen, se leen del repo del Producto en su tag): el compose y el Caddyfile de referencia, `rings/` con `active.caddy` y `ring.args`, la sala de espera, y la herramienta de anillos. La herramienta y el generador de `ring.args` viajan **en la imagen** de cada versión (`/app/deploy/rollout/`, con su sha256 en el label `vergis.rollout.sha256`): tómalos de ahí, no de un clon del repo en otra rama.

## 2 · Los plugins

```sh
claude plugin marketplace add Gegolabs/vergis --sparse .claude-plugin plugins
claude plugin install vergis@vergis
claude plugin install custos@vergis   # si la instalación gobierna el dato desde aquí
claude plugin install mira@vergis     # si la instalación opera el Botlet Mira
```

- **Tres plugins, un marketplace.** `vergis` opera la plataforma y su contenido; `custos`, el gobierno del dato (acceso, identidad y dueños); `mira`, el ciclo del spec de un Producto de Información. `custos` y `mira` **dependen de `vergis`**: instalar cualquiera de los dos instala también `vergis`, que trae el CLI.
- **`--sparse` es obligatorio**: sin él, el marketplace clona el repo entero del Producto y lo vuelve a bajar en cada actualización. (Solo vale para fuentes git o GitHub: un checkout local del Producto se agrega como directorio, sin `--sparse`.)
- Si el repo de operación es **compartido**, todos los comandos llevan `--scope project`. Con uno solo, otra máquina con el clon tendría un plugin habilitado y el marketplace desconocido.
- **El plugin `vergis` existe desde la 0.40.0**, y `custos` y `mira` desde la versión que los publica: un tag anterior no los trae, y el marketplace fijado a él no instala nada.
- Los plugins van **fijados al tag** de la versión del Producto: el de la versión v conoce el contrato hasta v, y lo posterior lo lee del nodo. Actualizarlos es `claude plugin marketplace update vergis` + `claude plugin update <plugin>@vergis` por cada uno.
- **Publicar una versión de Vergis (tag e imagen) no es de ningún plugin**: es del mantenedor del Producto.

## 3 · La declaración — `vergis-ops.json`

Vive en la **raíz del repo del operador**. Los plugins **no traen ningún hecho de ninguna instalación**: todo lo que es de la tuya se escribe acá. El esquema está en `${CLAUDE_PLUGIN_ROOT}/schema/vergis-ops.schema.json` (cada clave trae su `description`); el `$schema` del archivo apunta a su URL **en el tag** que usas, para tener autocompletado.

**Es inventario operativo: no es secreto, pero no es público.** Lleva topología, cuentas técnicas e identidades de sondeo — jamás un valor secreto: donde hay un secreto, la declaración lleva la **ruta** del archivo que lo contiene. `check` advierte si el repo que la contiene es público.

### Lo mínimo

```json
{
  "$schema": "https://raw.githubusercontent.com/Gegolabs/vergis/v<versión>/plugins/vergis/schema/vergis-ops.schema.json",
  "schema_version": 1,
  "installations": [
    {
      "id": "<kebab-case>",
      "transport": { "kind": "local" },
      "host": { "root": "/ruta/de/la/instalacion" },
      "rings": { "env_file": "rings/rollout.env" }
    }
  ]
}
```

Con eso corren `check`, `health` y la ceremonia de anillos. **Cada verbo que necesite algo más sale con 2 y nombra la clave**: se agrega entonces, no antes.

### Lo que se agrega según lo que la instalación opera

| Si vas a… | Declara | Cuidado |
|--|--|--|
| operar un host remoto | `transport`: `ssh` (`host`, `user`, `identity_file`, `sudo`) o `az-run-command` (`resource_group`, `vm`, `expected_account`) | la llave **fuera de git**; el host y la VM también en el `RESOURCES.md` del repo si lo tiene |
| sondear Lets y RLS | `probe_identities` y `rls_checks` | **nunca personas reales sin su acuerdo**; una comprobación de RLS se declara **medida**, con un `absent` que demuestre el fail-closed |
| medir paridad y publicar | `mirror.families` (y `mirror.unmirrored` con el motivo de cada montaje que no se espeja) | las rutas locales existen; lo excluido lleva su razón |
| tocar servicios | `services[]` con `interrupting` (ante la duda, `true`), `reload`, `prevalidate`; `host.compose_project` y `host.compose_file` | un servicio que no está en el compose del espejo es defecto |
| actos con gate | `governance`: `source` (la norma que funda los gates, **citada, no copiada**), `stage`, `availability`, `window_approver` (quien autoriza una ventana: el operador de la instalación), `approver` (quien aprueba lo destructivo), `gates` por clase, `pretest`, `acts_log`, `cuts_log` | una clase sin gate es `approval`; si la norma y la declaración difieren, **gana la norma** y la declaración se corrige en el mismo commit |
| alojar el poller en otro lado que el borde | `instrument.container` (de **vida larga**, nunca efímero) y `instrument.baseline_seconds` | recrear ese contenedor corta la medición |
| recrear el **borde** con su ventana y el corte medido | `instrument.container` apuntando a un contenedor de vida larga que **no** sea el borde | sin declararlo, el poller vive en el borde (`RINGS_EDGE`) y `exec service <borde> recreate` **se niega** mientras corra ahí; `check` dice qué servicio aloja el instrumento (con `rings.env_file` no puede: el archivo vive en el host, y lo dice en una nota) |
| operar datos | `extensions.data`: la skill que los atiende | sin ella, «fuera del Producto» |

### Validar

```sh
vergis-ops check
```

Sale 0 o 2 y **nombra cada defecto**: clave obligatoria ausente, `id` repetido, ruta del espejo inexistente, llave versionada, norma citada inexistente, servicio fuera del compose, transporte ausente del `RESOURCES.md`. Los tags móviles del compose y un repo público son **advertencias** que no suben el exit. Se itera hasta 0; recién entonces `vergis-ops recon`.

## Paso 0 de toda skill · ¿Desde dónde parto?

Todas las skills de los tres plugins empiezan aquí:

```sh
vergis-ops check      # la declaración se puede usar (0 o 2; nombra el defecto)
vergis-ops recon      # check + health + contrato + anillos + paridad, sin tocar nada
```

- Un **drift previo** (paridad en 1) se **reporta antes de seguir**: actuar encima mezcla el cambio propio con el ajeno.
- `recon` dice la distancia entre la versión del plugin y la del nodo. Es normal (lo posterior se lee del nodo), pero una actualización pendiente del plugin no debería pasar inadvertida.
- Si el punto de partida no está sano (health en 1), no es un cambio: es un incidente.

## ¿Qué clase de acto es?

**El riesgo lo gobierna la clase del acto, no el nombre de la skill.** Lo que corta el servicio pide ventana y lo destructivo pide aprobación, viva donde viva el acto. **Lo que recarga en caliente se lee del NODO, jamás de una tabla de memoria.** Las reglas copiadas se pudren: una regla vieja de «reiniciar para que tome la tabla» ya hizo reiniciar una plataforma entera para publicar un solo spec, cuando el nodo lo recargaba solo.

```sh
vergis-ops contract classify <archivo del espejo>   # la clase, por qué, y el gate que le toca
vergis-ops contract env <VARIABLE>                  # ¿qué exige cambiarla? anillo nuevo (version) · boot si la comparten todos los anillos · nada
vergis-ops contract                                 # watches, envs de arranque, artefactos pendientes
```

| Clase | Qué es | Cómo se decide | Skill |
|--|--|--|--|
| `read` | mirar | — | todas |
| `content` | contenido que el nodo recarga en caliente | un `watch` del contrato vivo cubre la ruta (en el nodo) | `vergis:publish`, `vergis:connect`, `custos:enforce`, `mira:specialize` |
| `boot` | lo que el nodo lee al arrancar | montado en el nodo y sin `watch`; **o sin contrato que responda** (ante la duda, corte) | aquí, o `vergis:rollout` si exige anillo nuevo |
| `service` | un servicio de la instalación, sin corte | lo monta un servicio con `interrupting: false`; o nada vivo lo monta | aquí |
| `service-interrupting` | un servicio cuya recarga corta rutas servidas | `interrupting: true`, o un servicio que la declaración no describe | aquí |
| `version` | cambiar la versión de Vergis por anillos | — | `vergis:rollout` |
| `destructive` | borrar datos, volúmenes, anillos | siempre explícito | la que actúe, con su gate |

**El gate lo declara la instalación** (`governance.gates`), citando la norma que lo funda (`governance.source`); si la declaración y la norma difieren, **gana la norma** y la declaración se corrige. Una clase sin gate declarado pide **aprobación**.

| Gate | Qué exige | Cómo se da la evidencia |
|--|--|--|
| `free` | nada | — |
| `operator` | lo decide quien ejecuta, **con red**: respaldo, plan de reversa, verificación medida | el CLI respalda y verifica; tú registras |
| `window` | **ventana de mantenimiento** autorizada por quien la instalación nombra en `window_approver` (su operador: sabe qué usuarios dependen de ella ahora), el **impacto declarado antes** y el **corte medido** | `--impact "<qué Lets caen y por cuánto>"` · `--window "<quién · cuándo · sus palabras>"` · poller corriendo |
| `approval` | el OK explícito de `approver` | `--approval "<quién · cuándo · sus palabras>"` (y `--impact` si corta) |

En una plataforma en GA típica, **lo que no corta no pide permiso** (se aplica con red) y **lo que corta pide ventana**, no permiso para desplegar: la ventana solo tiene sentido si hay corte. Lo destructivo pide aprobación. La declaración de cada instalación dice cómo es la suya; la skill no lo supone.

**El plugin no puede obligar a que exista la aprobación humana: exige su evidencia y la registra.** Nunca se escribe una evidencia que no existe.

## `service` y `service-interrupting` — compose, borde, proxy de identidad, sidecars

1. Editar **el espejo** y commitearlo. Nunca editar el host a mano.
2. `vergis-ops publish <archivo>` (el compose o el archivo del servicio).
3. Si el servicio declara `prevalidate`: `vergis-ops exec service <nombre> prevalidate` (contenedor efímero; no toca el vivo).
4. `service-interrupting` en un gate `window`: declarar el impacto, tener la ventana autorizada, **arrancar el poller** (`vergis-ops poller start`) con su control negativo **contra el anillo previo si existe** (`vergis-ops poller cn1 --ring <previo>`: uno en espera o retenido, nunca el activo), y recién entonces actuar. **Con un solo anillo no hay control negativo posible** (cn1 contra el activo, o sin anillo, sale 2): se actúa igual, y la fila del corte lo declara — «sin CN-1: la instalación tiene un solo anillo».
5. `vergis-ops exec service <nombre> reload` (si declara recarga en caliente) o `recreate`. `reload` **compara lo que el contenedor VE** en cada montaje de archivo contra el host: un editor o un `sed -i` cambian el inodo y el contenedor sigue viendo lo viejo — recargar no es haber leído lo nuevo. Si sale 1 por eso, el camino es `recreate`, con su gate.
6. `vergis-ops poller stop` da el corte. **La fila va a `governance.cuts_log` aunque diga «sin medir», y por qué**: una fila ausente hace creer que el corte no ocurrió. Las muestras `SINMEDIR` van en la fila como «sin medir», no como «corte»: el poller del plugin usa timeout de 2 s y no mide latencia, así que una retención de la sala de espera > 2 s también sale `SINMEDIR` (límite conocido, #367; `vergis:rollout` §6).
7. `vergis:verify`.

**El contenedor que aloja el poller no se recrea mientras el poller corra**: sería matar la medición a mitad de serie y dejar la fila del corte «sin medir». El CLI se niega (2), y lo averigua **en el host** (el contenedor donde corre el poller contra los del servicio), no en una clave declarada. **Por omisión el poller vive en el borde** (`RINGS_EDGE`), así que recrear el borde con su ventana exige **moverlo primero**: `instrument.container` en la declaración apuntando a otro contenedor de vida larga que ese acto no recree, `vergis-ops poller stop`, `vergis-ops poller start` (ya en el nuevo) con su CN-1, y recién entonces `recreate`. `vergis-ops check` dice de antemano qué servicio aloja el instrumento — salvo que el borde venga de `rings.env_file`: ese archivo vive en el host y `check` no lo lee, así que no puede nombrar el servicio y lo dice en una nota (la guardia del `recreate` sigue averiguándolo en el host).

## `boot` — una variable de arranque, un montaje del nodo

`vergis-ops contract env <VARIABLE>` decide el camino:

- **Si exige anillo nuevo** (`version`): **no se hace aquí**. Va por `vergis:rollout`: `ring.args` regenerado (`vergis-ops exec rollout ring-args --apply`) y la ceremonia de promoción, instrumentada.
- **Si la comparten todos los anillos** (como `VERGIS_OUT` o el lease): es `boot` de verdad — corte, ventana y medición, con el mismo flujo de `service-interrupting`. Lee antes el **RUNBOOK §7 «Cambiar la configuración de arranque con anillos»** de la versión que corre la instalación (`https://github.com/Gegolabs/vergis/blob/v<versión>/deploy/rollout/RUNBOOK.md`: no viaja en la imagen, se lee del repo del Producto en su tag).

## `destructive`

Borrar datos, volúmenes o anillos: gate `approval` (o el que declare la instalación), con impacto declarado. **Hay actos que ningún plugin ejecuta aunque se declaren**, porque son invariantes del Producto y no gates: `docker compose down -v` (borra volúmenes del borde), tocar el lease del plano de control (`control.lease.json`, `control.handover.json`), editar `ring.args` o `active.caddy` a mano. `vergis-ops exec run --class <clase> -- <sh>` —el acto gobernado libre— los rechaza con 2.

## Datos y motor de datos

No son de los plugins. Si la instalación declara `extensions.data`, esa skill atiende la carga, el DDL, la ingesta al almacén de datos y el terreno. Si no la declara: **«fuera del Producto: no cubierto por esta instalación»**, y se dice así. La seguridad a nivel de fila en la fuente es del gobierno del dato: `custos:enforce`.

## ¿Dónde queda el registro?

Rige para todas las skills que actúan, en los tres plugins:

- Cada acto con efecto: una entrada en `governance.acts_log` con qué se hizo, la clase, el gate y su evidencia, las mediciones con su exit y el rollback.
- Cada corte (o cada acto que pudo cortar): una fila en `governance.cuts_log`, con el instrumento, su versión, si corrió el CN-1, y el número — o «sin medir» y por qué.
- Si la instalación no declara dónde, la salida del CLI es el registro: se pega en el reporte.

## ¿Qué queda escrito al terminar la preparación?

- `vergis-ops.json` commiteado en el repo del operador, con `check` en 0.
- Si el repo usa un inventario de accesos (`RESOURCES.md`), una línea que apunte a la declaración.
- Si el repo es compartido, el `settings.json` del proyecto con las entradas de los plugins (el marketplace y la habilitación de cada uno), commiteado.

## ¿Qué no hace esta skill?

- No publica contenido (→ **vergis:publish**), no declara Conectores (→ **vergis:connect**), no cambia la versión de Vergis (→ **vergis:rollout**), no verifica por su cuenta (→ **vergis:verify**).
- No decide gates: los lee. No inventa evidencia de una aprobación.
- No repara un drift de paso: lo reporta.
- No opera varias instalaciones a la vez: cada acto es sobre una.

• *Generado con Wingworking*
