#!/bin/sh
# 07-primera-promocion.sh — la PRIMERA promoción de la instancia GH, cuando el activo todavía es el NODO
# COMPOSE (`mira-vergis-1`) y no un anillo registrado.
#
# Por qué existe (verificado en vergis-rollout v0.24.0, cmd_promote, y en control-lease.ts): cuando no
# hay anillo activo registrado, la herramienta hace el flip del borde y espera a que el candidato tome
# el control «por relevo del lease». Pero el intent de handover ORDENA LA FILA, JAMÁS OTORGA el
# control: el titular (el nodo compose) solo lo suelta con SIGUSR2 o al morir. Sin esta señal, el
# candidato espera todo el presupuesto y la herramienta vuelve atrás. Este wrapper envía SIGUSR2 al
# nodo compose en cuanto la herramienta declara el flip, y deja el log de todo el acto.
#
# Se corre en la VM (host, root), en /opt/mira, con el poller YA corriendo (work/231 §6).
# Uso: sh 07-primera-promocion.sh 0.24.0
# Solo para esta primera vez: desde que el activo es un anillo registrado, `vergis-rollout promote`
# a secas hace el handover completo y este wrapper NO se usa.
set -u
VERSION=${1:?uso: primera-promocion.sh <versión>}
COMPOSE_NODE=${COMPOSE_NODE:-mira-vergis-1}
MARCA="no hay anillo activo vivo"
# shellcheck source=/dev/null
set -a; . "${ROLLOUT_ENV:-/opt/mira/rings/rollout.env}"; set +a
RINGS_PROMOTE_TIMEOUT=${PRIMERA_TIMEOUT:-30}   # margen para el relevo manual; después vuelve a 10
export RINGS_PROMOTE_TIMEOUT
LOG=${LOG_DIR:-/opt/mira/rings}/promote-$VERSION-$(date +%s).log
echo "[wrapper] $(date -u +%T) promote $VERSION · log $LOG · nodo compose: $COMPOSE_NODE"
${ROLLOUT:-vergis-rollout} promote "$VERSION" >"$LOG" 2>&1 &
PID=$!
enviado=0
while kill -0 "$PID" 2>/dev/null; do
  if [ "$enviado" = 0 ] && grep -q "$MARCA" "$LOG"; then
    if docker kill -s USR2 "$COMPOSE_NODE" >/dev/null; then
      echo "[wrapper] $(date -u +%T.%N) SIGUSR2 → $COMPOSE_NODE (suelta el control; sigue sirviendo lecturas)"
    else
      echo "[wrapper] $(date -u +%T.%N) NO se pudo enviar SIGUSR2 a $COMPOSE_NODE — la herramienta volverá atrás sola"
    fi
    enviado=1
  fi
  sleep 0.2
done
wait "$PID"; RC=$?
echo "----- salida de vergis-rollout -----"; cat "$LOG"; echo "-----"
echo "[wrapper] promote rc=$RC · señal enviada=$enviado"
# GUARDIA POST-ABORT (medida en V-16d, corrida 2): si la herramienta volvió atrás, restauró el borde
# hacia el nodo compose y mandó USR2 al candidato ANTES de que éste adquiriera, el candidato puede
# adquirir 200 ms después (el intent lo nombra y el nodo compose ya soltó) y quedarse con el control
# mientras el borde apunta a un standby: CERO serving hasta que alguien intervenga. Acá se detecta y se
# le manda SIGUSR2 al candidato (que ya suelta bien desde 0.25.1) para que el nodo compose re-adquiera.
fase() { docker exec "$1" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>process.stdout.write(j.phase||'?')).catch(()=>process.stdout.write('sin-respuesta'))" 2>/dev/null || printf 'sin-respuesta'; }
if [ "$RC" != 0 ] && [ "$enviado" = 1 ]; then
  CAND="vergis-$(printf '%s' "$VERSION" | tr . -)"
  i=0; senal_cand=0
  while [ "$i" -lt 45 ]; do
    fc=$(fase "$COMPOSE_NODE")
    if [ "$fc" = serving ]; then echo "[wrapper] $(date -u +%T.%N) post-abort: $COMPOSE_NODE volvió a serving a los ${i}s"; break; fi
    fa=$(fase "$CAND")
    if [ "$fa" = serving ] && [ "$senal_cand" = 0 ]; then
      echo "[wrapper] $(date -u +%T.%N) post-abort: el candidato $CAND tomó el control DESPUÉS del abort con el borde ya restaurado → SIGUSR2 → $CAND"
      docker kill -s USR2 "$CAND" >/dev/null 2>&1 || echo "[wrapper] NO se pudo enviar SIGUSR2 a $CAND"
      senal_cand=1
    fi
    sleep 1; i=$((i + 1))
  done
  [ "$(fase "$COMPOSE_NODE")" = serving ] || echo "[wrapper] ATENCIÓN post-abort: $COMPOSE_NODE NO está en serving (fase: $(fase "$COMPOSE_NODE"); candidato: $(fase "$CAND")). Intervenir a mano: docker logs de ambos."
fi
[ "$enviado" = 1 ] || echo "[wrapper] ATENCIÓN: la marca '$MARCA' nunca apareció — el flujo no fue el esperado; leer el log antes de tocar nada"
exit "$RC"
