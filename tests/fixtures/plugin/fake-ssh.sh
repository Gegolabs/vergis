#!/bin/sh
# fake-ssh.sh — un `ssh` FALSO para las pruebas del transporte del plugin: ejecuta el script que llega
# por stdin con `sh` local, y registra los argumentos (para afirmar BatchMode, -i, sudo).
#   FAKE_SSH_MODE=fail  simula la caída del transporte (ssh sale 255)
set -u
[ -n "${FAKE_LOG:-}" ] && echo "ssh $*" >> "$FAKE_LOG"
[ "${FAKE_SSH_MODE:-ok}" = fail ] && { echo "ssh: connect to host h port 22: Connection refused" >&2; exit 255; }
exec sh -s
