#!/bin/sh
# fake-az.sh — un `az` FALSO para las pruebas del transporte del plugin (V3 del diseño lab/work/285).
#
# Reproduce las cinco caras del canal `az vm run-command` que el lab midió y que el transporte existe
# para no confundir, según FAKE_AZ_MODE:
#   ok        corre el script con sh y devuelve el mensaje con el formato de az ([stdout] … [stderr])
#   mute      «Enable succeeded» con el stdout vacío (el remoto murió mudo; az igual sale 0)
#   cross     corre el script pero entrega la salida con el centinela de OTRA corrida
#   truncate  corta la salida por el FINAL (se pierde el centinela)
#   headcut   corta la salida por el PRINCIPIO (llega el centinela, faltan líneas)
#   conflict  «(Conflict) Run command extension execution is in progress», rc=1
#   slow      como ok, pero tarda FAKE_AZ_SLEEP segundos (para el candado)
# En TODOS los modos que entregan salida, el stdout se recorta como lo recorta az: se conservan solo los
# ÚLTIMOS FAKE_AZ_CAP bytes (default 4096; #369: un contrato de 4,1 KB perdía la cabeza y el BEGIN).
# `az account show` devuelve FAKE_AZ_ACCOUNT. Cada invocación de run-command deja inicio y fin en FAKE_LOG.
set -u
ms() { node -p 'Date.now()'; }
if [ "${1:-} ${2:-}" = "account show" ]; then printf '%s\n' "${FAKE_AZ_ACCOUNT:-op@ejemplo.test}"; exit 0; fi
if [ "${1:-} ${2:-}" != "vm run-command" ]; then echo "fake-az: no sé hacer «$*»" >&2; exit 2; fi
script=""
while [ $# -gt 0 ]; do case "$1" in --scripts) script=${2#@}; shift 2 ;; *) shift ;; esac; done
[ -n "${FAKE_LOG:-}" ] && echo "start $(ms) $$" >> "$FAKE_LOG"
mode=${FAKE_AZ_MODE:-ok}
case "$mode" in
  conflict) echo "(Conflict) Run command extension execution is in progress. Please wait for completion before invoking a run command." >&2; exit 1 ;;
  mute) printf 'Enable succeeded: \n[stdout]\n\n[stderr]\n'; exit 0 ;;
esac
[ "$mode" = slow ] && sleep "${FAKE_AZ_SLEEP:-2}"
o=$(sh "$script" 2>&1)
case "$mode" in
  cross) o=$(printf '%s\n' "$o" | sed 's/[0-9a-f]\{20\}/0123456789abcdef0123/g') ;;
  truncate) n=$(printf '%s' "$o" | wc -c); o=$(printf '%s' "$o" | head -c $((n / 2))) ;;
  headcut) n=$(printf '%s' "$o" | wc -c); o=$(printf '%s' "$o" | tail -c $((n / 2))) ;;
esac
o=$(printf '%s\n' "$o" | tail -c "${FAKE_AZ_CAP:-4096}")
printf 'Enable succeeded: \n[stdout]\n%s\n[stderr]\n\n' "$o"
[ -n "${FAKE_LOG:-}" ] && echo "end $(ms) $$" >> "$FAKE_LOG"
exit 0
