# NEXT — Vergis

PROD corre **0.15.0** y está sano. El frente del lockfile de Renovate **avanzó hasta su último
eslabón y ahí se topó con un bloqueo que solo César puede levantar** — no es una dificultad del
lockfile, es un permiso del PAT. Árbol limpio salvo lo de esta sesión; un solo PR abierto (#166, del
lab, esperando ventana de César).

## Lo primero: por qué Renovate solo procesa UNA rama por corrida

De ~19 ramas candidatas procesa **solo la primera** (`renovate/pin-dependencies`), imprime
*«Repository has changed during renovation - aborting»* y corta. **Nunca llega a ninguna rama npm** —
y por eso el último eslabón del lockfile no se pudo verificar. Es **PREEXISTENTE**: la corrida
`31591828225` (11:26 UTC, sobre `bc0402b`, antes de tocar nada) ya lo traía.

**La causa NO está identificada, y conviene no repetir el error que ya se cometió hoy con esto.**
Lo único medido es la secuencia, limpia, en la corrida `31599885826`:

```
INFO: Branch updated (branch=renovate/pin-dependencies)  commitSha 9468d33…
INFO: Repository has changed during renovation - aborting
```

La propia escritura de Renovate a esa rama **precede** al abort. Por qué eso cuenta como «el
repositorio cambió» **no está medido**.

⚠️ **Ya se publicó una causa falsa para esto y se retiró el mismo día.** Se afirmó que era el **403
al publicar commit status**, porque en tres corridas aparecía pegado al abort. **La corrida
`31599885826` lo refutó: abortó igual con CERO 403.** El 403 es otro síntoma del mismo paso. Fue
ascender un patrón sospechoso a mecanismo sin medir el eslabón — y la afirmación alcanzó a mandar a
César a tocar el PAT antes de caerse. **No repetir: acá hace falta una corrida que salga distinta si
la hipótesis es falsa.**

**Hipótesis falsable, sin correr:** `pin-dependencies` se actualiza en cada corrida (digests + rebase
contra un `main` que avanzó), así que sería el hecho de escribirla lo que corta. **Predicción: si esa
rama se mergea o se cierra, la corrida debería continuar hacia las ramas npm.** Es el experimento más
barato disponible y es el próximo paso natural.

## Aparte, y ya no como causa: el PAT no puede publicar commit statuses

`POST /repos/Gegolabs/vergis/statuses/<sha>` ⇒ **403 «Resource not accessible by personal access
token»**. **Vale arreglarlo igual** —Renovate no puede publicar el status del cooldown, que es
evidencia visible del control— **pero no es lo que aborta la corrida**, y esa distinción es la
corrección de arriba.

**Qué hacer** (solo César puede): en https://github.com/settings/personal-access-tokens , sobre el
PAT del secret `RENOVATE_TOKEN`, agregar **`Commit statuses: Read and write`**. El workflow documenta
Contents · Pull requests · Workflows · Issues · Metadata — **falta Statuses**.

## El fail-closed del workflow: decidido, y a medio construir

César decidió que el workflow **debe ponerse rojo** cuando la corrida aborta: hoy declara la doctrina
—«preferimos el rojo honesto; un control apagado tiene que verse»— y la viola, corriendo a un
quinceavo de su alcance en verde.

**Paso 1 hecho** (`09f1b9a`): el workflow instrumenta el resultado. **Mide, no bloquea.**
**Y la medición ya descartó la vía obvia:** el `reportType` de Renovate **no sirve** — genera 45 KB
con shape `{problems, repositories:{…{problems:[], branches:[], packageFiles}}}`, un inventario de
dependencias, no un resultado. En una corrida que **sí abortó** no contiene `repository-changed` y
`problems` viene vacío. **Un gate colgado de ahí habría dado verde siempre.**

**Paso 2 pendiente:** encontrar la vía real. Candidata sin probar: `LOG_FILE` apuntando a `/tmp`
—que el runner ve por el bind mount `/tmp:/tmp` que la acción ya hace— y grepear la frase del abort.
Medir antes de bloquear, otra vez.

## Después: cerrar el último eslabón del lockfile (ya no debería costar)

El `postUpgradeTasks` **está implementado y medido** (commits `3bae7a1`, `b884960`). Lo único que
falta es verlo aplicar y commitear el lockfile bueno **en una rama npm de Renovate** — que es
exactamente lo que el 403 impide alcanzar.

**Cuando el PAT esté arreglado:**

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/cesar/wworkspace/productos/vergis
gh workflow run renovate.yml --ref main -f logLevel=debug
# medir — SIEMPRE confirmando primero que la rama toca el lockfile:
gh api "repos/Gegolabs/vergis/compare/main...<rama>" -q '.files[].filename' | grep package-lock
gh api "repos/Gegolabs/vergis/contents/package-lock.json?ref=<rama>" -q '.content' | base64 -d | grep -c '@esbuild/'
```

**Criterio de éxito, declarado antes de medir: 234.** Control: `main` da 234; las ramas de Renovate
daban 156. Hay un script con las tres trampas ya incorporadas en el scratchpad de la sesión
(`medir.sh`), pero se rehace en dos minutos si se perdió.

## Lo que quedó VERIFICADO hoy — no volver a discutirlo

- **`allowedCommands` SÍ abre la puerta en este montaje.** Señal **positiva**, no ausencia de error:
  el log de `31596456516` muestra la opción parseada dentro del contenedor y el comando ejecutado
  con sus `spawnargs` exactos. Era el supuesto grande del kit anterior. **Cerrado.**
- **El comando repara el lockfile: 156 → 234, bump preservado** (ajv 8.20.0). Medido DENTRO de la
  imagen real del bot (`ghcr.io/renovatebot/renovate:43` + `install-tool node 22.22.3` ⇒ npm 10.9.8),
  sobre el árbol exacto de `renovate/npm-ajv-vulnerability`.
- **La objeción razonable de que el comando fuera el mismo que Renovate ya ejecuta quedó REFUTADA
  por medición**, no por argumento.

## Terreno ya recorrido — no reintentar

- **`constraints.npm >= 10` + `engines.npm >= 10` — REFUTADO** (medido, sigue en 156). Se deja por
  correcto e inocuo.
- **`binarySource=install` — REFUTADO** (medido sobre las ramas recreadas de #171/#172). Ya retirado.
- **«npm poda las optional deps» — REFUTADO hoy**, y esto es nuevo: el MISMO comando en el MISMO
  entorno produce 234. Renovate regenera el lockfile por otra vía. **La causa sigue sin identificar**
  — el `postUpgradeTasks` compensa, no cura.
- **`installTools` NO es un array** (la doc pública dice que sí; el validator dice objeto), **y su
  versión debe ir exacta**: containerbase rechaza `^22.0.0` y `>=22` con «tool version not
  supported». Ya está puesto bien; no «simplificarlo» a un rango.
- **El `renovate-config-validator` verifica FORMA, no SEMÁNTICA.** Aceptó los rangos que la corrida
  rechaza. **Pasar el gate no es prueba de que la corrida sobreviva** — sigue siendo obligatorio
  correrlo (atajó dos errores hoy), pero no alcanza como evidencia.
- **La imagen del bot trae `node` pero NO `npm`.** Sin `installTools`, `spawn npm ENOENT` y el
  `unhandledRejection` **tumba la corrida entera**. `install-tool npm` solo tampoco sirve: «parent
  tool not installed: node».
- **Borrar ramas de Renovate para forzar regeneración — nunca.** Cierra el PR de forma irreversible
  y Renovate lo lee como rechazo. Costó los PRs #167 y #168.
- **Claves inventadas en `renovate.json` — nunca.** Invalidan el archivo y Renovate **detiene todos
  los PRs** (#170, 40 min de parálisis). Los comentarios van en `description`, que acepta array.
- **Trampa de medición 1:** una rama que **no toca `package-lock.json`** hereda el de `main` y da 234
  — no mide nada. Confirmar siempre con `compare`.
- **Trampa de medición 2:** `git show origin/<rama>:archivo` da lecturas rancias tras un rebase.
  Usar la API de contenidos.
- **Trampa de medición 3:** ausencia de error **no** prueba que algo funcione. Exigir señal
  **positiva**. Corolario medido hoy: un `grep ENOENT` sobre el log dio 7 falsos positivos — eran
  **los propios comentarios de la config** describiendo el error. El instrumento tiene que
  distinguir «lo dice» de «lo hace».

## Después de eso: issue #161 — la plataforma observa sus propias cargas

Es el frente con un usuario esperando del otro lado.

**El incidente que lo funda** (instancia Grupo Hijuelas, 2026-08-07/11): un usuario subió cinco
archivos, el job de conversión abortó, y la causa quedó escrita en un log interno que **nadie leyó
durante cuatro días** — hasta que reclamó. La plataforma tuvo toda la información desde el principio;
no tuvo a nadie mirándola.

**Lo que hace bueno al issue, y hay que preservar al diseñar:**

- **La señal central es barata y universal**: la zona de aterrizaje de un slot es zona de paso, así
  que **un archivo que envejece ahí *es* una carga que no completó** — sin importar dominio ni
  formato.
- **Distinguir «sin novedad» de «no pude medir»** es requisito explícito, no adorno: en ese mismo
  incidente un listado del almacenamiento devolvió **vacío-con-éxito** por un problema de permisos, y
  esa lectura habría concluido «el usuario nunca subió nada». *(El 403 del PAT de arriba es
  exactamente el mismo modo de falla, en otro plano: un permiso que falta y se lee como «todo bien».)*
- **No pide reintentos ni auto-reparación**: detectar y avisar; decidir es de las personas.

Relacionado: **#162** es la otra mitad del ciclo (que el fallo llegue al usuario con la causa, y el
contrato `_logs/` que el error ya promete). Conviene mirarlos juntos aunque se construyan aparte.

## Lo demás abierto (pendiente, no residuo)

En `TODO.md` y `PENDINGS.md`. De César: revisión legal de `CONTRIBUTING.draft.md` —renombrarlo **es**
publicarlo—, la marca, y el mapa de identidad (#159 / `P-22`, 44 personas pierden acceso). Sin tocar:
**#162** y **#163**/**#164**/**#165** (los tres de autorización del lab; **#163**, control por
columna, ganó peso: la doctrina de terreno ancho sellada allá declara como único límite que no
existe).
