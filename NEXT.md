# NEXT — Vergis

Renovate quedó **operando** (corridas verdes, Dependency Dashboard en el issue #169) y su primera
pasada abrió dos PRs de seguridad. Pero **todo PR suyo nace con el CI en rojo**: el `package-lock.json`
que él regenera pierde entradas de plataforma y `npm ci` aborta. La causa está localizada del lado de
Renovate y medida; el arreglo está aplicado pero **sin probar**. Además hay un desperfecto que causé
yo y hay que revertir: los dos PRs de seguridad están cerrados porque les borré la rama.

PROD corre **0.15.0** desde el 2026-08-11 22:21 y está sano (8/8 PIs, `healthz ok:true`). Eso no
depende de nada de lo de abajo.

## Próximo paso

**Correr Renovate y medir el lockfile de `renovate/typescript-5.x`.** Es el experimento que decide si
`RENOVATE_BINARY_SOURCE: install` arregla el defecto, y con él se destraba que los PRs de Renovate
sean mergeables.

**Contexto para arrancar en frío:**

- La casilla `unlimit-branch=renovate/typescript-5.x` **ya quedó marcada** en el dashboard (issue
  #169). Esa rama sí toca `package-lock.json`, que es lo que la vuelve un instrumento válido.
- No corrió todavía por **`prHourlyLimit` de `config:recommended` (2 PRs/hora)**, agotado la noche
  del 11. Basta esperar a la hora siguiente.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/cesar/wworkspace/productos/vergis
gh workflow run renovate.yml --ref main
# esperar a que termine, luego MEDIR (por API, no por refs locales — ver trampas):
gh api "repos/Gegolabs/vergis/contents/package-lock.json?ref=renovate/typescript-5.x" \
  -q '.content' | base64 -d | grep -c '@esbuild/'
```

- **Criterio de éxito, declarado antes de medir: `234` valida el fix · `156` lo refuta.** El control
  es `main`, que da 234.
- Antes de creerle a cualquier rama, verificar que **toca el lockfile**:
  `gh api "repos/Gegolabs/vergis/compare/main...<rama>" -q '.files[].filename'`.

## Reponer los dos PRs de seguridad — y desarmar la red

**#167 (`ajv` → ^8.20.0) y #168 (`yaml` → ^2.9.0) están CLOSED y no se pueden reabrir**: les borré
la rama y una rama borrada cierra el PR de forma irreversible. Renovate además lee un PR cerrado como
rechazo y deja de reproponer esa actualización.

- La recuperación en curso es **`"recreateWhen": "always"` en `renovate.json`**, puesta el 11 y
  **todavía sin efecto** (mismo límite horario).
- 🔴 **Quitar `recreateWhen` —y su `_comentario_recreateWhen`— en cuanto los dos PRs vuelvan a
  existir.** Si se queda, resucita cualquier PR que César cierre a propósito. El propio `renovate.json`
  lleva la nota de que es temporal.
- **Urgencia real: baja, y está medida.** El ReDoS de `ajv` (CVE-2025-69873) **no aplica**: exige
  `$data: true` y el árbol instancia `new Ajv({ allErrors: true, strict: false })` sin un solo uso de
  `$data`. El de `yaml` (CVE-2026-33532) hoy solo lo alcanza un operador — se parsea en
  `miranda/publish.ts`, `miranda/forma.ts` e `instance-config.ts`, y `MIRANDA_SCOPE_GROUP` es un grupo
  unipersonal. **Vigilar cuando Miranda abra su audiencia.**

## Si el experimento refuta el fix

Siguiente lever **no verificado**: correr con `LOG_LEVEL=trace` para capturar qué npm usa Renovate —
`debug` **no lo imprime** (comprobado). El workflow ya acepta `-f logLevel=debug`; `trace` habría que
agregarlo a las opciones del `workflow_dispatch`.

Salida de emergencia, **explícitamente un parche**: empujar a mano el lockfile correcto a cada rama
(regenerado con `npm install --package-lock-only --ignore-scripts`, que produce 234). Cierra esos PRs
pero deja la causa viva para el lunes siguiente, y Renovate deja de gestionar las ramas tocadas.

## Terreno ya recorrido

- **`constraints.npm >= 10` + `engines.npm >= 10` — insuficiente.** Aplicado (`81423d8`) y medido:
  se forzó el rebase de las dos ramas por la casilla `rebase-all-open-prs`, las ramas **sí** se
  regeneraron (`Branch updated`, HEADs nuevos) y el conteo siguió en **156**. Se deja puesto porque es
  correcto e inocuo, pero **no resuelve**. No reintentar por ahí.
- **Borrar ramas de Renovate para forzar regeneración — nunca más.** Cierra el PR de forma
  irreversible y Renovate marca la actualización como rechazada. Es el origen del daño a revertir.
- **`renovate/pin-dependencies` no sirve de instrumento.** Da 234, pero **no toca
  `package-lock.json`** (solo workflows y Dockerfiles): hereda el de `main`. Casi se publica como
  validación del fix.
- **Medir lockfiles con `git show origin/<rama>:…` es poco fiable acá** — dio lecturas rancias tras
  un rebase. Usar la API de contenidos.

## Lo demás que queda abierto (no es residuo, es pendiente)

Vive en `TODO.md` y `PENDINGS.md`. Lo que pide acción de César: la revisión legal de
`CONTRIBUTING.draft.md` (renombrarlo **es** publicarlo), la marca, y la decisión del mapa de
identidad (#159 / `P-22`, 44 personas pierden acceso). Sin tocar: los issues **#161** y **#162**.

<!-- /ww:next · 2026-08-11 · HEAD 6e679f9 -->
