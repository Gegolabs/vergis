# NEXT — Vergis

PROD corre **0.15.0** y está sano. Renovate opera completo: el cooldown de 14 días protegiendo **y**
la excepción para CVEs urgentes leyendo de verdad —verificado con señal positiva, no con ausencia de
error—. Las dos CVEs (`ajv`, `yaml`) están cerradas. Árbol limpio, un solo PR abierto (#166, del lab,
esperando ventana de César).

Quedan **dos frentes decididos y sin arrancar**, en el orden en que conviene tomarlos.

## Próximo paso

**Compensar el defecto del lockfile de Renovate con `postUpgradeTasks`.** Es corto y destranca todo
lo demás: mientras cada PR suyo nazca rojo, nadie los mergea y el cooldown queda decorativo.

**El reencuadre que lo justifica** —y es lo que no hay que volver a discutir—: la pregunta útil no es
«¿cuál es la causa?» sino «¿qué cuesta la fricción?». **Perseguir la causa ya quemó dos hipótesis sin
resultado** (ver Terreno recorrido). Y la fricción cuesta donde más duele: la falla aterriza en el
camino de seguridad, donde un CVE que se saltó el cooldown —como fue diseñado— se queda en rojo
esperando trabajo manual.

**Qué hacer:**

1. En `renovate.json`, `postUpgradeTasks` que corra `npm install --package-lock-only --ignore-scripts`
   con `fileFilters` sobre `package-lock.json`.
2. En el workflow, permitir ese comando: **`allowedCommands` es opción *global-only* del
   administrador del bot** (antes `allowedPostUpgradeCommands`) — se pasa por env al contenedor de
   la acción. **La controlamos por ser self-hosted**; como GitHub App esto no se podría.
3. Puede hacer falta `allowShellExecutorForPostUpgradeCommands` según cómo se exprese el comando.

**Existencia verificada** en la documentación de Renovate; **NO verificado en este montaje**.

**Criterio de éxito, declarado antes de medir: el lockfile del próximo PR de Renovate da 234.**
Control: `main` da 234; las ramas de Renovate daban 156.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/cesar/wworkspace/productos/vergis
gh workflow run renovate.yml --ref main
# medir — SIEMPRE confirmando primero que la rama toca el lockfile:
gh api "repos/Gegolabs/vergis/compare/main...<rama>" -q '.files[].filename' | grep package-lock
gh api "repos/Gegolabs/vergis/contents/package-lock.json?ref=<rama>" -q '.content' | base64 -d | grep -c '@esbuild/'
```

**Es compensación, no cura, y conviene decirlo al registrarlo:** la causa sigue sin identificar. Si
la divergencia de npm produce algo más allá de las optional deps de esbuild, esto lo enmascara —
aunque no es peor que el workaround manual, solo automático.

⚠️ Ojo con `prHourlyLimit` (2/hora, de `config:recommended`): si no aparece rama nueva, no es que
falle — está limitado. El dashboard #169 lo dice en «Rate-Limited» y tiene casillas `unlimit-branch`.

## Después: issue #161 — la plataforma observa sus propias cargas

Es el frente con un usuario esperando del otro lado.

**El incidente que lo funda** (instancia Grupo Hijuelas, 2026-08-07/11): un usuario subió cinco
archivos, el job de conversión abortó, y la causa quedó escrita en un log interno que **nadie leyó
durante cuatro días** — hasta que reclamó. La plataforma tuvo toda la información desde el principio;
no tuvo a nadie mirándola.

**Lo que hace bueno al issue, y hay que preservar al diseñar:**

- **La señal central es barata y universal**: la zona de aterrizaje de un slot es zona de paso, así
  que **un archivo que envejece ahí *es* una carga que no completó** — sin importar dominio ni
  formato. No hace falta entender el contenido.
- **Distinguir «sin novedad» de «no pude medir»** es requisito explícito, no adorno: en ese mismo
  incidente un listado del almacenamiento devolvió **vacío-con-éxito** por un problema de permisos, y
  esa lectura habría concluido «el usuario nunca subió nada».
- **No pide reintentos ni auto-reparación**: detectar y avisar; decidir es de las personas.

Relacionado: **#162** es la otra mitad del ciclo (que el fallo llegue al usuario con la causa, y el
contrato `_logs/` que el error ya promete). Conviene mirarlos juntos aunque se construyan aparte.

## Terreno ya recorrido — no reintentar

- **`constraints.npm >= 10` + `engines.npm >= 10` — REFUTADO.** Medido con las ramas regeneradas:
  siguieron en 156. Se deja puesto por correcto e inocuo, pero no resuelve.
- **`binarySource=install` — REFUTADO.** Medido sobre las ramas recreadas de #171/#172, que sí tocan
  el lockfile: 156. Ya retirado del workflow.
- **Borrar ramas de Renovate para forzar regeneración — nunca.** Cierra el PR de forma irreversible
  y Renovate lo lee como rechazo. Costó los PRs #167 y #168.
- **Claves inventadas en `renovate.json` — nunca.** Una clave fuera del esquema invalida el archivo
  y Renovate **detiene todos los PRs** (pasó: #170, 40 min de parálisis, y dejó sin efecto el propio
  flag que el comentario documentaba). Los comentarios van en `description`, que acepta array.
- **Trampa de medición 1:** una rama que **no toca `package-lock.json`** hereda el de `main` y da 234
  — no mide nada. Confirmar siempre con `compare` antes de creerle.
- **Trampa de medición 2:** `git show origin/<rama>:archivo` dio lecturas rancias tras un rebase.
  Usar la API de contenidos.
- **Trampa de medición 3:** ausencia de un WARN en el log **no** prueba que el permiso funcione —
  puede que el bot abortara antes de llegar a comprobarlo (pasó con la config inválida). Exigir
  señal **positiva**: `No vulnerability alerts found`, no «no dijo nada».

## Lo demás abierto (pendiente, no residuo)

En `TODO.md` y `PENDINGS.md`. De César: revisión legal de `CONTRIBUTING.draft.md` —renombrarlo **es**
publicarlo—, la marca, y el mapa de identidad (#159 / `P-22`, 44 personas pierden acceso). Sin tocar:
**#162** y **#163**/**#164**/**#165** (los tres de autorización del lab; **#163**, control por
columna, ganó peso: la doctrina de terreno ancho sellada allá declara como único límite que no
existe).

<!-- /ww:next · 2026-08-12 · HEAD cfdae2b -->
