#!/bin/sh
# lint-shell.sh — el gate de shellcheck del repo. Se corre con `npm run lint:shell`, igual en local
# que en CI (la paridad se logra porque el CI invoca el script de npm, no un comando crudo).
#
# POR QUÉ DESCUBRE Y NO ENUMERA. Dos de los tres scripts de shell del repo son extensionless
# (`bin/vergis`, `deploy/rollout/vergis-rollout`), así que un glob `**/*.sh` habría cubierto 259 de
# 1130 líneas — dejando fuera justo el archivo grande. Y una lista escrita a mano tiene un modo de
# falla peor que no tener gate: el script nuevo que nadie agregó a la lista pasa en VERDE, y el verde
# se lee como «linteado». Acá la fuente de verdad es `git ls-files` + el shebang: lo que el repo
# versiona y se declara shell, se lintea. `git ls-files` además excluye `node_modules/` por
# construcción (no está versionado), donde hay scripts de shell de terceros que no son nuestros.
# Se le suma `--others --exclude-standard` para que el script recién escrito y todavía sin `git add`
# también entre: si el gate solo mirara el índice, la corrida local previa al commit —justo la que
# tiene que atrapar el error— saldría verde por no ver el archivo nuevo.
#
# POR QUÉ NO SE PASA `-s`. shellcheck deriva el dialecto del shebang, y eso es justo lo que se quiere:
# los scripts de este repo declaran `#!/bin/sh` porque la VM objetivo corre `sh` y está medido que un
# bashismo muere con «Syntax error» a mitad de despliegue (ver la cabecera de `vergis-rollout` y el
# test «es POSIX sh sin bashismos»). Forzar `-s bash` volvería el gate ciego a su razón de ser: en
# modo bash los bashismos son legales. Forzar `-s sh` a todos juzgaría mal el día que entre un script
# que legítimamente declare bash. El shebang manda, y el shebang es lo que la VM lee.
#
# ESTE SCRIPT SABE REPORTAR SU PROPIO FALLO. Si shellcheck no está, o si el descubrimiento no
# encuentra nada, sale ROJO en vez de verde: un instrumento que confunde «medí y salió limpio» con «no
# pude medir» produce datos con cara de verdad.
#
# POR QUÉ DECLARA LA VERSIÓN. Un gate cuya severidad depende de qué versión trae el runner no es un
# gate reproducible, y «verde en local» deja de significar algo. Medido: sobre `deploy/rollout/
# vergis-rollout`, shellcheck 0.9.0 (la que traía la imagen `ubuntu-latest`) reportaba tres SC2015 que
# 0.11.0 no reporta. La versión autoritativa se declara acá y el CI la instala pinneada por checksum
# (ver el job `shell` de `.github/workflows/build.yml`); este script solo la CONTRASTA.
#
# Y por qué el aviso no es rojo en local: un desarrollador con otra versión tiene que poder trabajar —
# se le dice que sus hallazgos pueden diferir del gate, no se le bloquea la máquina. En el CI sí es
# rojo, vía LINT_SHELL_STRICT=1: si el pin se rompe (release retirada, cache, un `apt` que se cuela en
# el PATH), el gate volvería a ser irreproducible EN SILENCIO, que es exactamente el defecto que este
# bloque existe para cerrar.

set -eu

# La versión que corre el gate autoritativo (el CI). Cambiarla acá exige cambiar SHELLCHECK_VERSION y
# SHELLCHECK_SHA256 en `.github/workflows/build.yml`: son el mismo hecho escrito en dos lados.
SHELLCHECK_ESPERADO=0.11.0

cd "$(dirname "$0")/.."

if ! command -v shellcheck >/dev/null 2>&1; then
  printf 'lint-shell: shellcheck no está instalado — NO se midió nada.\n' >&2
  printf '  macOS: brew install shellcheck · Debian/Ubuntu: apt-get install -y shellcheck\n' >&2
  exit 1
fi

SHELLCHECK_INSTALADO=$(shellcheck --version | sed -n 's/^version: //p')
if [ "$SHELLCHECK_INSTALADO" != "$SHELLCHECK_ESPERADO" ]; then
  printf 'lint-shell: AVISO — versión de shellcheck DIVERGENTE.\n' >&2
  printf '  El gate autoritativo corre %s; esta corrida usa %s. Los hallazgos pueden diferir.\n' \
    "$SHELLCHECK_ESPERADO" "${SHELLCHECK_INSTALADO:-<no se pudo leer>}" >&2
  if [ "${LINT_SHELL_STRICT:-0}" = 1 ]; then
    printf '  LINT_SHELL_STRICT=1 (el gate autoritativo): esto es ROJO. El pin de versión se rompió.\n' >&2
    exit 1
  fi
  printf '  En local es solo aviso: se sigue midiendo con la versión instalada.\n' >&2
fi

LISTA=$(mktemp)
trap 'rm -f "$LISTA"' EXIT HUP INT TERM

# Un archivo por línea. Los nombres versionados de este repo no llevan saltos de línea; si algún día
# los llevaran, `git ls-files` los devolvería citados y shellcheck fallaría al abrirlos — rojo, no
# verde silencioso.
git ls-files --cached --others --exclude-standard | while IFS= read -r f; do
  [ -f "$f" ] || continue
  es_shell=0
  case "$f" in
  *.sh) es_shell=1 ;;
  esac
  if [ "$es_shell" = 0 ]; then
    # El shebang, con y sin argumentos: `#!/bin/sh`, `#!/usr/bin/env sh`, `#!/bin/dash -e`.
    case "$(head -n 1 "$f" 2>/dev/null || :)" in
    '#!'*sh | '#!'*sh[!A-Za-z0-9_]*) es_shell=1 ;;
    esac
  fi
  if [ "$es_shell" = 1 ]; then printf '%s\n' "$f"; fi
done >"$LISTA"

if [ ! -s "$LISTA" ]; then
  printf 'lint-shell: el descubrimiento no encontró NINGÚN script de shell versionado.\n' >&2
  printf '  Eso no es «limpio»: es el instrumento roto. Revísalo antes de creerle.\n' >&2
  exit 1
fi

set --
while IFS= read -r f; do set -- "$@" "$f"; done <"$LISTA"

printf 'lint-shell: %s archivo(s) bajo shellcheck v%s (esperada v%s)\n' "$#" \
  "$SHELLCHECK_INSTALADO" "$SHELLCHECK_ESPERADO"
printf '%s\n' "$@" | sed 's/^/  · /'

# `--severity=style` es el default de shellcheck hoy; se escribe explícito para que un cambio de
# default en el futuro no afloje el gate sin que nadie lo haya decidido.
shellcheck --severity=style --color=never "$@"
printf 'lint-shell: sin hallazgos.\n'
