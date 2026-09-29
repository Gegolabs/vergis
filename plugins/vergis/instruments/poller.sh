#!/bin/sh
# poller.sh — EL poller de corte de Vergis (deploy/rollout/RUNBOOK.md §0.3, «El poller, escrito»).
#
# POSIX sh con BusyBox `wget`: corre en el contenedor del BORDE (`RINGS_EDGE`), que toda instalación con
# anillos tiene y que ningún acto de anillos recrea — o en el contenedor de vida larga que la instalación
# declare en `instrument.container`. NUNCA en uno efímero: un poller que muere durante el acto termina su
# serie donde empezó el corte, y eso acota el corte POR ABAJO sin decir que no pudo medir.
#
#   sh poller.sh <url-de-healthz> [intervalo-en-segundos]      (default 0.25)
#
# Una línea por muestra:   <uptime-s> <HH:MM:SS> OK|MAL|SINMEDIR <detalle>
#
# LA LEY, en el código y no en la memoria:
#   · El predicado es `200 ∧ phase=serving ∧ lets.serving == lets.total`. Jamás «responde».
#   · El cuerpo tiene que ser JSON (empieza con `{` y termina con `}`). La sala de espera del borde lleva
#     `"phase":"serving"` en un comentario HTML: sin esta guardia, un 503 del borde se leería sano.
#   · Lee `lets` y, si no está, `pis` (nodos < 0.27.0) — y ETIQUETA cuál leyó. Conteos sueltos fuera de
#     los dos bloques: contrato que este poller no sabe leer ⇒ MAL.
#   · Cuerpo vacío o no-JSON ⇒ MAL (el borde respondió, pero no con salud). Sin respuesta HTTP ⇒ SINMEDIR,
#     que se cuenta aparte: «no pude medir» nunca se lee como verde.
#   · El reloj es `/proc/uptime` (centésimas, el mismo kernel para todos los contenedores del host): la
#     resolución que se busca es de décimas, y el `date` de BusyBox solo da segundos.
set -u
url=${1:?uso: poller.sh <url-de-healthz> [intervalo]}
iv=${2:-0.25}
E=/tmp/vergis-ops-poller.$$.err
# La trampa de TERM TERMINA: una trampa que solo limpia deja al poller vivo después de `poller stop`
# (medido al construir V4: un `kill` no lo paraba), y un poller huérfano sigue escribiendo en el borde.
trap 'rm -f "$E"' EXIT
trap 'rm -f "$E"; exit 0' INT TERM HUP
while :; do
  up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
  hh=$(date -u +%H:%M:%S)
  if b=$(wget -q -T 2 -O- "$url" 2>"$E"); then
    one=$(printf '%s' "$b" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$one" in
      '{'*'}') js=1 ;;
      *) js=0 ;;
    esac
    ph=$(printf '%s' "$one" | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([a-z-]*\)".*/\1/p')
    blk=lets
    bl=$(printf '%s' "$one" | sed -n 's/.*"lets"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
    if [ -z "$bl" ]; then
      blk=pis
      bl=$(printf '%s' "$one" | sed -n 's/.*"pis"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
    fi
    tt=$(printf '%s' "$bl" | sed -n 's/.*"total"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    sv=$(printf '%s' "$bl" | sed -n 's/.*"serving"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    sueltos=0
    if [ -z "$bl" ] && printf '%s' "$one" | grep -q '"total"[[:space:]]*:[[:space:]]*[0-9]'; then sueltos=1; fi
    if [ -n "$bl" ]; then cnt="$blk=${sv:-?}/${tt:-?}"; else cnt="lets=-"; fi
    if [ "$js" = 1 ] && [ "$ph" = serving ] && [ "$sueltos" = 0 ] && { [ -z "$bl" ] || { [ -n "$tt" ] && [ "$tt" = "$sv" ]; }; }; then
      printf '%s %s OK status=2xx phase=%s %s\n' "$up" "$hh" "$ph" "$cnt"
    else
      why=""
      [ "$js" = 1 ] || why=" cuerpo-no-json=$(printf '%s' "$one" | cut -c1-60 | tr ' ' '_')"
      [ "$sueltos" = 0 ] || why="$why conteos-fuera-de-bloque"
      printf '%s %s MAL status=2xx phase=%s %s%s\n' "$up" "$hh" "${ph:--}" "$cnt" "$why"
    fi
  else
    if grep -q 'server returned error' "$E" 2>/dev/null; then
      st=$(sed -n 's/.*HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$E" | head -1)
      printf '%s %s MAL status=%s phase=- lets=-\n' "$up" "$hh" "${st:-?}"
    else
      printf '%s %s SINMEDIR %s\n' "$up" "$hh" "$(head -c 80 "$E" 2>/dev/null | tr '\n ' '__')"
    fi
  fi
  sleep "$iv"
done
