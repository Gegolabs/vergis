---
description: Preparar la operación de una instalación de Vergis — la preparación única del RUNBOOK (compose y borde de referencia, rings/, la herramienta de anillos), instalar el plugin vergis desde el marketplace del Producto, y AUTORAR la declaración vergis-ops.json con su esquema hasta que `vergis-ops check` salga 0. Usar cuando se instale Vergis por primera vez, se sume una instalación a un repo de operación, se pida «valida la declaración», «declara la instalación», «instala el plugin de vergis», o cualquier verbo de vergis-ops se niegue por falta de una clave de la declaración.
argument-hint: "[instalar | declarar | validar]"
---

# vergis:setup — preparar la operación de una instalación

**Lo que esta skill no hace:** crear infraestructura cloud, gastar, ni decidir la política de la instalación. Eso es del operador y de su gobierno. Esta skill deja el terreno listo para que **vergis:ops**, **vergis:rollout** y **vergis:verify** operen, y deja escrito en la declaración lo que el operador ya decidió.

## ¿Qué hace falta en la estación del operador?

- **Node ≥ 22** (el CLI del plugin es Node sin dependencias). Si falta, dilo y **detente**: nada de lo que sigue corre sin él.
- `git`, y Claude Code con plugins.
- El cliente del transporte de la instalación: `docker` local, `ssh` con llave, o `az` con sesión en la cuenta técnica.

## 1 · La instancia (una vez, si es nueva)

Sigue `deploy/rollout/README.md` §«Preparar la instancia» **de la versión que se va a instalar**: el compose y el Caddyfile de referencia, `rings/` con `active.caddy` y `ring.args`, la sala de espera, y la herramienta de anillos. La herramienta y el generador de `ring.args` viajan **en la imagen** de cada versión (`/app/deploy/rollout/`, con su sha256 en el label `vergis.rollout.sha256`): tómalos de ahí, no de un clon del repo en otra rama.

## 2 · El plugin

```sh
claude plugin marketplace add Gegolabs/vergis --sparse .claude-plugin plugins
claude plugin install vergis@vergis
```

- **`--sparse` es obligatorio**: sin él, el marketplace clona el repo entero del Producto y lo vuelve a bajar en cada actualización. (Solo vale para fuentes git o GitHub: un checkout local del Producto se agrega como directorio, sin `--sparse`.)
- Si el repo de operación es **compartido**, los **dos** comandos llevan `--scope project`. Con uno solo, otra máquina con el clon tendría el plugin habilitado y el marketplace desconocido.
- El plugin va **fijado al tag** de la versión del Producto: el de la versión v conoce el contrato hasta v, y lo posterior lo lee del nodo. Actualizarlo es `claude plugin marketplace update vergis` + `claude plugin update vergis@vergis`.

## 3 · La declaración — `vergis-ops.json`

Vive en la **raíz del repo del operador**. El plugin **no trae ningún hecho de ninguna instalación**: todo lo que es de la tuya se escribe acá. El esquema está en `${CLAUDE_PLUGIN_ROOT}/schema/vergis-ops.schema.json` (cada clave trae su `description`); el `$schema` del archivo apunta a su URL **en el tag** que usas, para tener autocompletado.

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
| operar datos | `extensions.data`: la skill que los atiende | sin ella, «fuera del Producto» |

### Validar

```sh
node ${CLAUDE_PLUGIN_ROOT}/bin/vergis-ops.mjs check
```

Sale 0 o 2 y **nombra cada defecto**: clave obligatoria ausente, `id` repetido, ruta del espejo inexistente, llave versionada, norma citada inexistente, servicio fuera del compose, transporte ausente del `RESOURCES.md`. Los tags móviles del compose y un repo público son **advertencias** que no suben el exit. Se itera hasta 0; recién entonces `vo recon` (vergis:ops).

## ¿Qué queda escrito al terminar?

- `vergis-ops.json` commiteado en el repo del operador, con `check` en 0.
- Si el repo usa un inventario de accesos (`RESOURCES.md`), una línea que apunte a la declaración.
- Si el repo es compartido, el `settings.json` del proyecto con las **dos** entradas del plugin (el marketplace y su habilitación), commiteado.

• *Generado con Wingworking*
