#!/bin/sh
# `docker` FALSO para probar `deploy/rollout/vergis-rollout` sin un demonio (issue #210 · I8).
#
# La herramienta habla con docker por UN solo punto (`docker_cli`, inyectable con `RINGS_DOCKER`), así
# que este script es todo el mundo que necesita: un mundo de archivos bajo `$FAKE_WORLD`.
#
#   $FAKE_WORLD/images/<ref>       → dos líneas: digest de registry, id de imagen
#   $FAKE_WORLD/containers/<name>  → líneas `image=`, `running=`, `phase=`
#   $FAKE_WORLD/calls.log          → cada invocación, para poder afirmar qué se llamó y qué NO
#   $FAKE_WORLD/schema             → «<schemaSupported> <fileVersion>» que declara /contrato
#
# Modela dos comportamientos que importan: `kill -s USR2` suelta el control (el contenedor pasa a
# `standby`) y ASCIENDE al que esperaba (mimetiza el relevo del lease), y el conmutador `:8079` resuelve
# su destino leyendo `active.caddy` — o sea que el smoke por el borde mide de verdad hacia dónde quedó
# apuntando el flip, no lo que la herramienta cree.
set -eu

: "${FAKE_WORLD:?FAKE_WORLD no definido}"
W=$FAKE_WORLD
mkdir -p "$W/images" "$W/containers"
printf '%s\n' "$*" >>"$W/calls.log"

esc() { printf '%s' "$1" | tr '/:' '__'; }
cval() { sed -n "s/^$2=//p" "$W/containers/$1" 2>/dev/null | head -1; }
cset() {
  _f="$W/containers/$1"
  _k=$2
  _v=$3
  if [ -f "$_f" ]; then grep -v "^$_k=" "$_f" >"$_f.new" 2>/dev/null || : >"$_f.new"; else : >"$_f.new"; fi
  printf '%s=%s\n' "$_k" "$_v" >>"$_f.new"
  mv "$_f.new" "$_f"
}

# RELEVO CONTINUO. El nodo real no espera a que alguien le hable: poltea el lease cada renewMs y toma el
# control en cuanto queda libre y su enfriamiento venció. Modelarlo solo en el momento del SIGUSR2 dejaba
# al previo sin poder recuperar el control tras un rollback inmediato — un artefacto del instrumento, no
# del mecanismo. Se evalúa en CADA invocación, que es cuando el tiempo del mundo avanza.
relevo() {
  _ahora=$(date +%s)
  for f in "$W"/containers/*; do
    [ -e "$f" ] || return 0
    if [ "$(cval "$(basename "$f")" phase)" = serving ]; then return 0; fi
  done
  for f in "$W"/containers/*; do
    n=$(basename "$f")
    c=$(cval "$n" cooled_until)
    if [ "$(cval "$n" running)" = true ] && [ "$(cval "$n" phase)" = standby ] &&
      { [ -z "$c" ] || [ "$c" -le "$_ahora" ]; }; then
      cset "$n" phase serving
      return 0
    fi
  done
}

healthz_body() {
  printf '{"ok":true,"engine":"fabric","phase":"%s","pis":{"total":2,"serving":2}}' "$1"
}
contrato_body() {
  _sup=$(cut -d' ' -f1 "$W/schema")
  _fil=$(cut -d' ' -f2 "$W/schema")
  printf '{"version":"0.19.0","engine":"fabric","control":{"mode":"lease","lease":{"holder":"h","epoch":3,"held":true,"file":"/governance/control.lease.json"},"ring":{"version":"0.19.0","digest":null,"name":"%s"},"loops":{"armed":true,"detail":[]},"store":[{"name":"gobierno","file":"/governance/governance.sqlite","mode":"escritura","schemaSupported":%s,"fileVersion":%s,"epoch":3,"fileEpoch":3,"degraded":false}]}}' "$1" "$_sup" "$_fil"
}

relevo

cmd=${1:-}
shift 2>/dev/null || true

case "$cmd" in
pull)
  ref=$1
  [ -f "$W/images/$(esc "$ref")" ] || {
    printf 'Error response from daemon: manifest for %s not found\n' "$ref" >&2
    exit 1
  }
  ;;
image)
  sub=$1
  shift
  case "$sub" in
  inspect)
    fmt='' ref=''
    while [ $# -gt 0 ]; do
      case "$1" in
      --format)
        shift
        fmt=$1
        ;;
      *) ref=$1 ;;
      esac
      shift
    done
    f="$W/images/$(esc "$ref")"
    [ -f "$f" ] || {
      printf 'Error: No such image: %s\n' "$ref" >&2
      exit 1
    }
    case "$fmt" in
    *RepoDigests*) sed -n '1p' "$f" ;;
    *) sed -n '2p' "$f" ;;
    esac
    ;;
  rm) rm -f "$W/images/$(esc "$1")" ;;
  *) exit 1 ;;
  esac
  ;;
inspect)
  fmt='' name=''
  while [ $# -gt 0 ]; do
    case "$1" in
    --format)
      shift
      fmt=$1
      ;;
    *) name=$1 ;;
    esac
    shift
  done
  [ -f "$W/containers/$name" ] || {
    printf 'Error: No such object: %s\n' "$name" >&2
    exit 1
  }
  case "$fmt" in
  *State.Running*) cval "$name" running ;;
  *.Image*) cval "$name" image ;;
  *) printf 'cid-%s\n' "$name" ;;
  esac
  ;;
create)
  name='' image='' prev=''
  while [ $# -gt 0 ]; do
    case "$1" in
    --name)
      shift
      name=$1
      ;;
    -e | --label | -v | --network | --env-file | --memory | --log-driver | --log-opt | --restart) shift ;;
    --init) : ;;
    *) prev=$1 ;;
    esac
    shift
  done
  image=$prev
  f="$W/images/$(esc "$image")"
  [ -f "$f" ] || {
    printf 'Unable to find image %s locally\n' "$image" >&2
    exit 1
  }
  cset "$name" image "$(sed -n '2p' "$f")"
  cset "$name" running false
  cset "$name" phase detenido
  printf 'cid-%s\n' "$name"
  ;;
start)
  cset "$1" running true
  # Semántica del lease: si NADIE tiene el control, el que arranca lo toma (relevo sobre lease libre);
  # si ya hay un activo, queda EN ESPERA — la fase que existe para que rutearle tráfico sea imposible.
  if [ "$(cval "$1" phase)" = detenido ]; then
    _hay_activo=false
    for f in "$W"/containers/*; do
      n=$(basename "$f")
      if [ "$n" != "$1" ] && [ "$(cval "$n" running)" = true ] && [ "$(cval "$n" phase)" = serving ]; then
        _hay_activo=true
      fi
    done
    if [ "$_hay_activo" = true ]; then cset "$1" phase standby; else cset "$1" phase serving; fi
  fi
  ;;
stop)
  cset "$1" running false
  cset "$1" phase detenido
  ;;
rm)
  for a in "$@"; do
    case "$a" in
    -*) ;;
    *) rm -f "$W/containers/$a" ;;
    esac
  done
  ;;
kill)
  sig='' name=''
  while [ $# -gt 0 ]; do
    case "$1" in
    -s)
      shift
      sig=$1
      ;;
    *) name=$1 ;;
    esac
    shift
  done
  if [ "$sig" = USR2 ]; then
    cset "$name" phase standby
    # ENFRIAMIENTO del que suelta: el nodo real no vuelve a aspirar al lease de inmediato (la marca de
    # release existe justamente para que el sucesor no espere el stale window, y el que la dejó la ve
    # primero). Sin modelar esto, dos anillos calientes se pasan el control en un ping-pong eterno — que
    # es lo que hizo visible la carrera del handover.
    # El enfriamiento es TEMPORAL, como en el nodo real (una ventana de segundos), no un contador de
    # eventos: quien soltó vuelve a ser aspirante legítimo un rato después, que es lo que hace posible el
    # rollback al previo.
    cset "$name" cooled_until $(($(date +%s) + 2))
    _ahora=$(date +%s)
    # Relevo: el primer aspirante que no está enfriado toma el control.
    for f in "$W"/containers/*; do
      n=$(basename "$f")
      c=$(cval "$n" cooled_until)
      if [ "$n" != "$name" ] && [ "$(cval "$n" running)" = true ] && [ "$(cval "$n" phase)" = standby ] &&
        { [ -z "$c" ] || [ "$c" -le "$_ahora" ]; }; then
        cset "$n" phase serving
        break
      fi
    done
  fi
  ;;
exec)
  c=$1
  shift
  case "${1:-}" in
  node)
    # `docker exec <c> node -e <js> <url> <headers>` → tras el shift: $1=node $2=-e $3=js $4=url
    #
    # El INTENT DE HANDOVER va por el mismo camino (`node -e`) y se reconoce por el marcador del
    # programa, igual que lo haría un lector humano: $4=sucesor (vacío ⇒ borrar), $5=segundos. El mundo
    # falso lo guarda en un archivo para poder AFIRMAR que se escribió, cuándo y a nombre de quién.
    case "$3" in
    *handover*)
      if [ -z "${4:-}" ]; then
        rm -f "$W/handover"
      else
        printf '%s %s\n' "$4" "${5:-}" >"$W/handover"
        printf '%s %s\n' "$4" "${5:-}" >>"$W/handover.log"
      fi
      exit 0
      ;;
    esac
    url=$4
    ph=$(cval "$c" phase)
    case "$url" in
    *8079*)
      # El conmutador resuelve su destino leyendo la línea que dejó el flip.
      tgt=$(sed -n 's/^reverse_proxy \([^:]*\):8080.*/\1/p' "${FAKE_RINGS_DIR:-/nope}/active.caddy" 2>/dev/null | head -1)
      if [ -z "$tgt" ] || [ ! -f "$W/containers/$tgt" ] || [ "$(cval "$tgt" running)" != true ]; then
        printf '502\n{"error":"no upstreams available"}'
        exit 0
      fi
      printf '200\n'
      healthz_body "$(cval "$tgt" phase)"
      ;;
    */healthz*)
      printf '200\n'
      healthz_body "$ph"
      ;;
    */contrato*)
      printf '200\n'
      contrato_body "$c"
      ;;
    *)
      printf '404\n{}'
      ;;
    esac
    ;;
  caddy)
    # `caddy validate` / `caddy reload` del borde: éxito salvo que el mundo pida lo contrario.
    if [ -f "$W/edge-fails" ]; then exit 1; fi
    ;;
  wget)
    # API de administración del borde: el pool de upstreams, derivado de la línea que dejó el flip.
    # Es informativo para la herramienta (no gatea nada); acá se modela para que la llamada no falle.
    tgt=$(sed -n 's/^reverse_proxy \([^:]*\):8080.*/\1/p' "${FAKE_RINGS_DIR:-/nope}/active.caddy" 2>/dev/null | head -1)
    printf '[{"address":"%s:8080","num_requests":0,"fails":0}]\n' "$tgt"
    ;;
  *) exit 1 ;;
  esac
  ;;
*)
  printf 'fake-docker: comando no modelado: %s %s\n' "$cmd" "$*" >&2
  exit 1
  ;;
esac
