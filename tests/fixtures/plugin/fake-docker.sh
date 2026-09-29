#!/bin/sh
# fake-docker.sh — un `docker` FALSO para las pruebas de los instrumentos del plugin (V4 del diseño
# lab/work/285). Se inyecta con VERGIS_OPS_DOCKER; el mundo vive en FAKE_WORLD:
#
#   $FAKE_WORLD/containers/<nombre>   una línea por dato:
#       ring=1                    el contenedor es un anillo (label vergis.ring)
#       service=<svc>             label com.docker.compose.service
#       mount=<origen>|<destino>  un montaje (uno por línea)
#       env=<K>=<V>               env del contenedor (lo ve lo que corre con `exec`)
#
# `exec` corre el comando EN ESTA MÁQUINA con el env del contenedor: el nodo real lo reemplaza un
# servidor HTTP de la prueba, al que el programa llega por VO_NODE_BASE / RINGS_EDGE_URL.
set -u
W=${FAKE_WORLD:?FAKE_WORLD}
[ -n "${FAKE_LOG:-}" ] && echo "docker $*" >> "$FAKE_LOG"
cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  inspect)
    name=${1:-}; [ $# -gt 0 ] && shift
    f="$W/containers/$name"
    [ -f "$f" ] || { echo "Error: No such object: $name" >&2; exit 1; }
    case "$*" in
      *Mounts*) sed -n 's/^mount=//p' "$f" ;;
      *compose.service*) sed -n 's/^service=//p' "$f" ;;
      *) echo '[{}]' ;;
    esac
    ;;
  ps)
    case "$*" in
      *vergis.ring*) for f in "$W"/containers/*; do [ -f "$f" ] && grep -q '^ring=1' "$f" && basename "$f"; done ;;
      *) for f in "$W"/containers/*; do [ -f "$f" ] && basename "$f"; done ;;
    esac
    exit 0
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
