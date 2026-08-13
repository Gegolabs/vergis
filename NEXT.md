# NEXT — Vergis

PROD corre **0.15.0** y está sano. **El frente de Renovate quedó CERRADO** el 2026-08-13: causa raíz
identificada, curada y verificada end-to-end. Lo que queda son tres PRs esperando tu merge, dos
decisiones chicas y el frente de fondo (#161).

## Lo primero: tres PRs de Renovate esperando merge

| PR | Rama | Qué es |
|----|------|--------|
| **#177** | `renovate/typescript-5.x` | `typescript ^5.9.3`. **Es la prueba viva de la cura**: su lockfile da **234** y nació VERDE (`test` ✓ `review` ✓ `stability-days` ✓). |
| **#176** | `renovate/ghcr.io-gegolabs-vergis-latest` | Digest de **nuestra propia imagen**. Ver la decisión de abajo antes de mergear. |
| **#175** | `renovate/caddy-2` | Digest de `caddy:2` en el compose de referencia. |

## Lo que se cerró, y por qué no hay que volver a abrirlo

**La causa del lockfile era la VERSIÓN DE npm.** Renovate regeneraba con **npm 12.0.2**, que poda las
optional deps de otras plataformas. Aislado con control limpio —mismo árbol, comando, imagen y
plataforma; solo cambia el npm—:

| npm | refs `@esbuild/` |
|-----|------------------|
| 10.9.8 | **234** |
| 12.0.2 | **156** |

**Curado** (`d1cb166`): `constraints.npm: "^10.9.8"` + `allowedVersions: "<11"` como **candado**
—Renovate tenía pendiente «update npm tool constraint to v12», que habría roto todo otra vez—.
**Verificado**: corrida `31719851935` instaló `npm 10.9.9`, regeneró la rama, lockfile 156 → 234,
PR verde.

**El 403 de commit statuses** que abortaba la corrida entera se resolvió con el permiso que agregaste
al PAT: cero abort, y de yapa el check `renovate/stability-days` ahora se publica — el cooldown de 14
días pasó de invisible a evidencia en cada PR.

**Retirado el `postUpgradeTasks`** y su `RENOVATE_ALLOWED_COMMANDS`: corría de verdad, pero era
inútil porque Renovate lo ejecutaba con el mismo npm 12 que causaba el defecto. Con la causa curada,
una compensación que enmascara es deuda. La palanca quedó **verificada** por si algún día hace falta.

## Dos decisiones chicas

1. **El pin de nuestra propia imagen.** `deploy/compose.reference.yml` fija
   `ghcr.io/gegolabs/vergis:latest@sha256:…`, así que **cada build de `main` publica un digest nuevo y
   Renovate abre un PR** (hoy, #176). Vino con el merge de #174 y estaba advertido en su cuerpo.
   **Decidir:** quitar el pin (si la referencia debe seguir el tag móvil) o ignorar ese paquete en
   `renovate.json` (si debe quedar fija). Tal como está, es churn perpetuo del bot sobre una imagen
   nuestra.
2. **El fail-closed del workflow, paso 2.** Decidiste que el job debe ponerse **rojo** cuando Renovate
   aborta; hoy sale verde. El paso 1 (`09f1b9a`) instrumenta pero **no bloquea**, y la medición
   **descartó la vía obvia**: el `reportType` es un inventario de dependencias — en una corrida que
   sí abortó no contenía `repository-changed` y `problems` venía vacío, así que un gate colgado de
   ahí **habría dado verde siempre**. Candidata sin probar: `LOG_FILE` a `/tmp` (el runner lo ve por
   el bind mount `/tmp:/tmp`) y grepear la frase del abort. **Medir antes de bloquear.**
   Menos urgente ahora que la causa del abort está resuelta, pero el hueco sigue abierto.

## La lección que se lleva esta sesión — instrumentos que mienten

**Cinco falsos positivos en dos días, todos de la misma familia**, y son la razón de que esto costara
tres días en vez de uno. Vale más que el arreglo:

- El **`renovate-config-validator`** acepta valores que la corrida rechaza (rangos en `installTools`
  ⇒ «tool version not supported»). **Verifica forma, no semántica**: pasarlo no es prueba de que la
  corrida sobreviva. Correrlo igual —atajó dos errores.
- **`grep ENOENT`** sobre el log dio 7 aciertos que eran **los propios comentarios de la config**
  describiendo el error. Lo mismo con `install-tool npm 12.0.2`, que en una corrida era solo el
  mensaje de commit volcado en `debug`. **Patrón fiable para el log real: `"command": "install-tool …"`.**
- **`grep '^- \[x\]'`** falló por un espacio inicial y reportó que una casilla no se había marcado.
- **Contar 403 en logs `info`** «refutó» una causa que era verdadera: `info` no imprime ese DEBUG, así
  que el contador medía el nivel de log, no el fenómeno.
- **Medir el lockfile solo con npm 10.9.8** exoneró durante tres días a la variable culpable.

**Todos comparten forma: el instrumento no distingue «no ocurrió» de «no lo registré», o confunde la
descripción del fenómeno con el fenómeno.** Corolario práctico: **un experimento que no varía la
variable sospechosa no la exonera — la ignora.**

*(Vale la pena evaluar si esto merece una entrada `W-03` en el WATCH global. No se tocó
`~/.claude/WATCH.md` desde acá: es otro repo y tiene cambios de otras sesiones sin sellar.)*

## Terreno recorrido — no reintentar

- **`binarySource=install` — REFUTADO** (medido). Ya retirado.
- **«`pin-dependencies` bloqueaba el tablero» — REFUTADO por su propio merge** (#174): la corrida
  siguiente abortó igual, tras una rama nueva.
- **Marcar `unlimit-branch` en el dashboard no destraba un abort**: ocurre antes de crear el PR.
- **Borrar ramas de Renovate — nunca.** Cierra el PR de forma irreversible y lo lee como rechazo
  (costó #167 y #168). **Forzar un rebase sí es seguro**: casilla `rebase-branch` del dashboard.
- **Claves inventadas en `renovate.json` — nunca.** Invalidan el archivo y Renovate **detiene todos
  los PRs** (#170, 40 min). Los comentarios van en `description`, que acepta array.
- **Trampa de medición:** una rama que **no toca `package-lock.json`** hereda el de `main` y da 234 —
  no mide nada; confirmar con `compare`. Y `git show origin/<rama>:archivo` da lecturas rancias tras
  un rebase: usar la API de contenidos.

## El frente de fondo: issue #161 — la plataforma observa sus propias cargas

Es el que tiene un usuario esperando del otro lado, y ahora es lo más importante del backlog.

**El incidente que lo funda** (instancia Grupo Hijuelas, 2026-08-07/11): un usuario subió cinco
archivos, el job de conversión abortó, y la causa quedó escrita en un log interno que **nadie leyó
durante cuatro días** — hasta que reclamó. La plataforma tuvo toda la información desde el principio;
no tuvo a nadie mirándola.

**Lo que hace bueno al issue, y hay que preservar al diseñar:**

- **La señal central es barata y universal**: la zona de aterrizaje de un slot es zona de paso, así
  que **un archivo que envejece ahí *es* una carga que no completó** — sin importar dominio ni formato.
- **Distinguir «sin novedad» de «no pude medir»** es requisito explícito, no adorno: en ese incidente
  un listado del almacenamiento devolvió **vacío-con-éxito** por un problema de permisos, y esa
  lectura habría concluido «el usuario nunca subió nada». **Es exactamente la familia de fallas que
  costó tres días en este frente** — vale la pena diseñar #161 con esa cicatriz a la vista.
- **No pide reintentos ni auto-reparación**: detectar y avisar; decidir es de las personas.

Relacionado: **#162** es la otra mitad del ciclo (que el fallo llegue al usuario con la causa, y el
contrato `_logs/` que el error ya promete). Conviene mirarlos juntos aunque se construyan aparte.

## Lo demás abierto

En `TODO.md` y `PENDINGS.md`. De César: revisión legal de `CONTRIBUTING.draft.md` —renombrarlo **es**
publicarlo—, la marca, y el mapa de identidad (#159 / `P-22`, 44 personas pierden acceso). Sin tocar:
**#162** y **#163**/**#164**/**#165** (los tres de autorización del lab; **#163**, control por
columna, ganó peso: la doctrina de terreno ancho sellada allá declara como único límite que no
existe).
