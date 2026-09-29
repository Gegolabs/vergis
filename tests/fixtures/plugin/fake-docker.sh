#!/bin/sh
# fake-docker.sh — un `docker` FALSO para las pruebas de los instrumentos del plugin (V4 del diseño
# lab/work/285). Se inyecta con VERGIS_OPS_DOCKER; el mundo vive en FAKE_WORLD:
#
#   $FAKE_WORLD/containers/<nombre>   una línea por dato:
#       ring=1                    el contenedor es un anillo (label vergis.ring)
#       service=<svc>             label com.docker.compose.service
#       mount=<origen>|<destino>  un montaje (uno por línea)
#       env=<K>=<V>               env del contenedor (lo ve lo que corre con `exec`)
#       running=0                 el contenedor está DETENIDO (un anillo retenido); `start` lo arranca
#
#   $FAKE_WORLD/images/<ref con / y : cambiados por _>   una imagen; su línea `sha256label=<v>` es el
#       label vergis.rollout.sha256 (lo que coteja `exec rollout install`)
#
# `exec` corre el comando EN ESTA MÁQUINA con el env del contenedor: el nodo real lo reemplaza un
# servidor HTTP de la prueba, al que el programa llega por VO_NODE_BASE / RINGS_EDGE_URL.
set -u
W=${FAKE_WORLD:?FAKE_WORLD}
[ -n "${FAKE_LOG:-}" ] && echo "docker $*" >> "$FAKE_LOG"
cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  inspect)
    # El nombre puede ir antes o después de `--format <plantilla>` (docker acepta los dos órdenes).
    if [ "${1:-}" = --format ]; then fmt=$2; shift 2; set -- "$@" --format "$fmt"; fi
    name=${1:-}; [ $# -gt 0 ] && shift
    f="$W/containers/$name"
    [ -f "$f" ] || { echo "Error: No such object: $name" >&2; exit 1; }
    case "$*" in
      *Mounts*) sed -n 's/^mount=//p' "$f" ;;
      *compose.service*) sed -n 's/^service=//p' "$f" ;;
      *State.Running*) if grep -q '^running=0' "$f"; then echo false; else echo true; fi ;;
      *.Id*) echo "id-$name" ;;
      *) echo '[{}]' ;;
    esac
    ;;
  pull) exit 0 ;;
  image)
    [ "${1:-}" = inspect ] || { echo "fake-docker: image no sabe «$*»" >&2; exit 2; }
    shift
    ref='' fmt=''
    while [ $# -gt 0 ]; do
      case "$1" in --format) fmt=$2; shift 2 ;; *) ref=$1; shift ;; esac
    done
    f="$W/images/$(printf '%s' "$ref" | tr '/:' '__')"
    [ -f "$f" ] || { echo "Error: No such image: $ref" >&2; exit 1; }
    case "$fmt" in
      *vergis.rollout.sha256*) v=$(sed -n 's/^sha256label=//p' "$f"); echo "${v:-<no value>}" ;;
      '') echo '[{}]' ;;
      *) echo '' ;;
    esac
    ;;
  start)
    f="$W/containers/${1:-}"
    [ -f "$f" ] || { echo "Error response from daemon: No such container: ${1:-}" >&2; exit 1; }
    grep -v '^running=' "$f" > "$f.t"; mv "$f.t" "$f"
    echo "${1:-}"
    ;;
  ps)
    case "$*" in
      *vergis.ring*) for f in "$W"/containers/*; do [ -f "$f" ] && grep -q '^ring=1' "$f" && basename "$f"; done ;;
      *com.docker.compose.service=*)
        svc=$(printf '%s\n' "$*" | sed -n 's/.*com\.docker\.compose\.service=\([^ ]*\).*/\1/p')
        for f in "$W"/containers/*; do [ -f "$f" ] && grep -qx "service=$svc" "$f" && basename "$f"; done ;;
      *) for f in "$W"/containers/*; do [ -f "$f" ] && basename "$f"; done ;;
    esac
    exit 0
    ;;
  compose)
    # Solo lo que los actos de servicio necesitan: `config -q` valida, `up -d` «recrea» (queda en FAKE_LOG).
    case "$*" in
      *" config -q"*) exit 0 ;;
      *" up -d "*) exit 0 ;;
      *) echo "fake-docker: compose no sabe «$*»" >&2; exit 2 ;;
    esac
    ;;
  exec)
    detach=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) detach=1; shift ;;
        -i|-t) shift ;;
        -e) shift 2 ;;
        *) break ;;
      esac
    done
    ct=$1; shift
    f="$W/containers/$ct"
    [ -f "$f" ] || { echo "Error response from daemon: No such container: $ct" >&2; exit 1; }
    while IFS= read -r l; do
      case "$l" in env=*) export "${l#env=}" ;; esac
    done < "$f"
    if [ "$detach" = 1 ]; then
      "$@" </dev/null >/dev/null 2>&1 &
      exit 0
    fi
    exec "$@"
    ;;
  *)
    echo "fake-docker: no sé hacer «$cmd $*»" >&2
    exit 2
    ;;
esac
