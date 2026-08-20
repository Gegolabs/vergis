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

set -eu

cd "$(dirname "$0")/.."

if ! command -v shellcheck >/dev/null 2>&1; then
  printf 'lint-shell: shellcheck no está instalado — NO se midió nada.\n' >&2
  printf '  macOS: brew install shellcheck · Debian/Ubuntu: apt-get install -y shellcheck\n' >&2
  exit 1
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

printf 'lint-shell: %s archivo(s) bajo shellcheck %s\n' "$#" \
  "$(shellcheck --version | sed -n 's/^version: /v/p')"
printf '%s\n' "$@" | sed 's/^/  · /'

# `--severity=style` es el default de shellcheck hoy; se escribe explícito para que un cambio de
# default en el futuro no afloje el gate sin que nadie lo haya decidido.
shellcheck --severity=style --color=never "$@"
printf 'lint-shell: sin hallazgos.\n'
