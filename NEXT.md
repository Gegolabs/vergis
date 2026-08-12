# NEXT — Vergis

PROD corre **0.15.0** y está sano (8/8 PIs, `healthz ok:true`). Renovate opera con su config válida,
las dos CVEs ya están aplicadas, y **no queda ningún frente a medio ejecutar**.

Lo que sigue abierto es un **defecto conocido con dos hipótesis ya refutadas**, y no bloquea nada
urgente: los PRs que Renovate abre nacen con el CI en rojo porque su regeneración del
`package-lock.json` pierde entradas de plataforma. Mergear uno suyo exige rehacerle el lockfile a
mano; el cooldown de supply chain —la razón de ser de tenerlo— sí funciona.

## Próximo paso

**Habilitar el permiso de alertas de vulnerabilidad — es de César y son dos clics.**

El dashboard (issue #169) avisa `WARN: Cannot access vulnerability alerts`. Sin ese permiso,
`osvVulnerabilityAlerts: true` **no tiene de dónde leer**, y esa clave es la mitad del diseño del
ADR-001: la que permite que un CVE urgente **se salte el cooldown de 14 días**. Hoy el cooldown está
protegiendo, pero la excepción que lo hace seguro no.

- **Dónde:** `Gegolabs/vergis` → Settings → **Code security**.
- **Cómo se comprueba después:** correr el workflow y verificar que el WARN desaparece del #169.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/cesar/wworkspace/productos/vergis
gh workflow run renovate.yml --ref main
```

## El defecto del lockfile — si alguien lo retoma

**El síntoma, medido y reproducible:** el `package-lock.json` que Renovate regenera trae **156**
referencias `@esbuild/`; `main` tiene **234**. `npm ci` exige correspondencia exacta árbol↔lock y
aborta en 6-10 s con `Missing: @esbuild/…@0.28.2 from lock file`.

**Cómo medirlo bien** (dos trampas ya pisadas, ver abajo):

```bash
# 1 · confirmar que la rama TOCA el lockfile — si no, no mide nada
gh api "repos/Gegolabs/vergis/compare/main...<rama>" -q '.files[].filename' | grep package-lock
# 2 · contar por API, no por refs locales
gh api "repos/Gegolabs/vergis/contents/package-lock.json?ref=<rama>" -q '.content' | base64 -d | grep -c '@esbuild/'
```

**Criterio: 234 = resuelto · 156 = sigue roto.** Control: `main` da 234.

**Lo único sin medir:** qué npm usa Renovate. `LOG_LEVEL=debug` **no lo imprime** (comprobado);
haría falta `trace`, que hoy no está en las opciones del `workflow_dispatch` del workflow.

**Workaround vigente, y es aceptable:** rehacerle el lockfile a mano al PR que se quiera mergear —
`npm install --package-lock-only --ignore-scripts` produce 234. Es lo que se hizo para las dos CVEs
(PR #173), y funciona.

## Terreno ya recorrido — cuatro caminos cerrados y dos trampas

- **`constraints.npm >= 10` + `engines.npm >= 10` — REFUTADO.** Aplicado y medido con las ramas
  regeneradas: siguieron en 156. Se deja puesto porque es correcto e inocuo, pero no resuelve.
- **`binarySource=install` — REFUTADO.** Medido sobre las ramas recreadas de #171/#172, que sí tocan
  el lockfile: 156. Retirado del workflow para no dejar una variable sin justificación.
- **Borrar ramas de Renovate para forzar regeneración — nunca más.** Cierra el PR de forma
  irreversible (no se puede reabrir sin la rama) y Renovate lo lee como rechazo. Costó los PRs #167
  y #168.
- **Comentarios en `renovate.json` con claves inventadas — nunca.** Una clave fuera del esquema
  (`_comentario_x`) invalida el archivo entero y Renovate **detiene todos los PRs** hasta que se
  corrija (pasó: issue #170, 40 minutos de parálisis). Los comentarios van en `description`, que
  acepta un array de strings. **El modo de falla es feo porque no se cae al escribirlo**: falla en el
  bot, asincrónico, y se manifiesta como «no pasa nada».
- **Trampa 1 — `renovate/pin-dependencies` no es instrumento**: da 234, pero no toca
  `package-lock.json` (solo workflows y Dockerfiles). Hereda el de `main`. Casi se publica como
  validación.
- **Trampa 2 — `git show origin/<rama>:archivo` dio lecturas rancias tras un rebase.** Usar la API.

## Lo demás abierto (pendiente, no residuo)

En `TODO.md` y `PENDINGS.md`. De César: la revisión legal de `CONTRIBUTING.draft.md` —renombrarlo
**es** publicarlo—, la marca, y el mapa de identidad (#159 / `P-22`, 44 personas pierden acceso).
Sin tocar: **#161**, **#162** (observabilidad de cargas) y **#163**/**#164**/**#165** (los tres de
autorización que abrió el lab; **#163**, control por columna, acaba de ganar peso: la doctrina de
terreno ancho sellada allá declara como su único límite que no existe).

<!-- /ww:next · 2026-08-11 · HEAD d0e5277 -->
