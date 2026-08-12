# NEXT — Vergis

PROD corre **0.15.0** y está sano. El frente del lockfile de Renovate **avanzó hasta su último
eslabón y ahí se topó con un bloqueo que solo César puede levantar** — no es una dificultad del
lockfile, es un permiso del PAT. Árbol limpio salvo lo de esta sesión; un solo PR abierto (#166, del
lab, esperando ventana de César).

## Lo primero: el permiso del PAT — es lo único que bloquea todo

**`Commit statuses: Read and write`** sobre el PAT del secret `RENOVATE_TOKEN`, en
https://github.com/settings/personal-access-tokens . El workflow documenta Contents · Pull requests ·
Workflows · Issues · Metadata — **falta Statuses**. Solo César puede editarlo.

**La cadena causal la escribe el propio Renovate**, en el mismo milisegundo (corrida `31623814773`):

```
DEBUG: POST /repos/Gegolabs/vergis/statuses/4d53aa6… = ERR_NON_2XX      17:41:46.887
DEBUG: Caught error setting branch status - aborting (branch=…)          17:41:46.888
       403 «Resource not accessible by personal access token»
DEBUG: Passing repository-changed error up (branch=…)                    17:41:46.892
 INFO: Repository has changed during renovation - aborting
```

**Efecto, medido en 9 corridas:** Renovate escribe **exactamente una rama** y corta; las demás (20 en
la última) solo las evalúa. **Nunca alcanza una rama npm** — por eso el `postUpgradeTasks` del
lockfile sigue sin verificarse end-to-end. Es **PREEXISTENTE** (ya estaba en `31591828225`, antes de
tocar nada) y **viola la doctrina fail-closed** del propio workflow: el control corre a una fracción
de su alcance, en verde.

⚠️ **Este punto se afirmó, se «corrigió» y se re-afirmó el mismo día. Vale la pena leer por qué antes
de tocarlo:** primero se publicó por correlación sin medir el eslabón; después se declaró refutado
porque una corrida abortó con **cero** 403 — **y esa refutación era inválida: el conteo se hizo sobre
logs en `info`, que no imprimen ese DEBUG**. El 403 aparece en las 3 corridas `debug` y en ninguna de
las 5 `info`, mientras el abort ocurre en las 8. **El contador medía el nivel de log, no el
fenómeno.** La lección que queda no es sobre el 403: **un instrumento que no distingue «no ocurrió»
de «no lo registré» fabrica refutaciones tan falsas como las afirmaciones que pretende arreglar.**

**Falta la confirmación por intervención** — la cadena está demostrada en el log, pero la prueba es
dar el permiso y ver desaparecer el abort. Justo después:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/cesar/wworkspace/productos/vergis
gh workflow run renovate.yml --ref main -f logLevel=debug
```

Si el abort desaparece y la corrida alcanza ramas npm, **se cierra el último eslabón del lockfile en
la misma corrida** — medir con el bloque de más abajo (criterio: **234**).

## Ya refutado, no reintentar

- **«`pin-dependencies` bloqueaba el tablero» — REFUTADO por su propio merge** (#174, `9b4b112`). La
  corrida siguiente abortó igual, tras una rama **nueva**. Esa rama no tenía nada de especial: el
  abort ocurre tras escribir la primera, sea cual sea. El merge sirvió para eso.
- **Marcar la casilla `unlimit-branch` del dashboard no destraba nada**: el abort ocurre **antes** de
  que Renovate cree el PR (medido en `31601603402`).

## Efecto colateral del merge, para decidir

`deploy/compose.reference.yml` ahora fija `ghcr.io/gegolabs/vergis:latest@sha256:…`, así que **cada
build de `main` publica un digest nuevo y Renovate mantiene `renovate/ghcr.io-gegolabs-vergis-latest`
viva para siempre**. Estaba señalado en el cuerpo del PR antes de mergear. No causa el abort, pero
garantiza churn perpetuo del bot sobre una imagen que es nuestra. **Decidir:** quitar el pin (si la
referencia debe seguir el tag móvil) o ignorar ese paquete en `renovate.json` (si debe quedar fija).

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
