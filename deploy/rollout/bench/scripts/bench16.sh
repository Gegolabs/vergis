#!/bin/sh
# bench16.sh — V-16: la PRIMERA promoción cuando el activo es un nodo SIN identidad de anillo.
#
# Qué mundo levanta, y en qué se diferencia del de `bench.sh`: acá NO hay dos anillos. Hay
#   · un NODO COMPOSE (`benchv14-vergis-1`) — misma imagen, mismos montajes, **sin `VERGIS_RING`**,
#     con alias de red `vergis`, que es exactamente lo que es `mira-vergis-1` en la instancia GH;
#   · un ANILLO instalado por `vergis-rollout install` (`vergis-9-9-1`), que llega a standby;
#   · el mismo borde, el mismo poller y el mismo mutador del banco V-14, sin relajar el predicado.
#
# NO TOCA `bench.sh` NI SUS CORRIDAS: es un archivo aparte, comparte el `compose.bench.yml`, el
# `Caddyfile.bench` y el `poller/` (que no se modifican) y usa el mismo `.run/`. Tras `limpiar`, un
# `sh scripts/bench.sh preparar` reconstruye el mundo V2…V14 desde cero como siempre.
#
# Uso:
#   sh scripts/bench16.sh preparar          el mundo: borde + NODO COMPOSE activo (sin anillos)
#   sh scripts/bench16.sh cn-instrumento    CN del INSTRUMENTO (standby ⇒ MAL · inexistente ⇒ SINMEDIR)
#   sh scripts/bench16.sh v16a              install del primer anillo con el nodo compose activo
#   sh scripts/bench16.sh v16b-cn           CONTROL NEGATIVO de V-16b: `promote` A SECAS, bajo medición
#   sh scripts/bench16.sh v16b              la primera promoción CON el wrapper, bajo medición
#   sh scripts/bench16.sh v16c              vuelta atrás manual (anillo → nodo compose), bajo medición
#   sh scripts/bench16.sh v16d              promoción ABORTADA a propósito, bajo medición
#   sh scripts/bench16.sh rss               V-RSS: `docker stats` de los dos nodos
#   sh scripts/bench16.sh estado            qué hay vivo, leído del SUJETO
#
# ⚠ No se edita este archivo mientras corre (`sh` lee por desplazamiento de bytes).

set -eu

BENCH=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$BENCH/../../.." && pwd)
TOOL="$REPO/deploy/rollout/vergis-rollout"
RUN="$BENCH/.run"
DATOS="$RUN/datos/v16"
CRUDOS="$BENCH/experimentos/v16"
COMPOSE="docker compose -f $BENCH/compose.bench.yml"

IMG=benchv14/vergis
VR=9.9.1                 # el anillo corre la MISMA versión que el nodo compose (como 0.24.0 en la VM)
NODO=benchv14-vergis-1   # el nodo compose: sin identidad de anillo, alias de red `vergis`
ANILLO=vergis-9-9-1

RINGS_DIR="$RUN/rings"
RINGS_IMAGE="$IMG"
RINGS_EDGE=benchv14-caddy
RINGS_EDGE_URL=http://benchv14-caddy:8079
RINGS_ADMIN_EMAIL=banco@v14.local
export RINGS_DIR RINGS_IMAGE RINGS_EDGE RINGS_EDGE_URL RINGS_ADMIN_EMAIL

say() { printf '%s\n' "$*"; }
die() { printf 'bench16: %s\n' "$*" >&2; exit 1; }
ahora_ms() { date +%s000; }

fase_de() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const b=await r.text();process.stdout.write(r.status+' '+b)}).catch(()=>process.stdout.write('sin-respuesta'))" 2>/dev/null || printf 'sin-respuesta'
}
edge_upstreams() { docker exec "$RINGS_EDGE" wget -q -O- "http://127.0.0.1:2019/reverse_proxy/upstreams" 2>/dev/null || printf '[]'; }
edge_dial() { docker exec "$RINGS_EDGE" wget -q -O- "http://127.0.0.1:2019/config/" 2>/dev/null | tr ',' '\n' | grep -i '"dial"' || printf '(sin dial)'; }
secreto_cargar() {
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET
}

esperar_fase() { # esperar_fase <contenedor> <fase> <segundos>
  _i=0
  while [ "$_i" -lt "$3" ]; do
    case "$(fase_de "$1")" in *"\"phase\":\"$2\""*) return 0 ;; esac
    sleep 1
    _i=$((_i + 1))
  done
  return 1
}

cmd_estado() {
  say "── estado VIVO (leído del sujeto) ──"
  say "  nodo compose ($NODO): $(fase_de "$NODO" | head -c 200)"
  if docker inspect "$ANILLO" >/dev/null 2>&1; then
    say "  anillo $VR ($ANILLO): $(fase_de "$ANILLO" | head -c 200)"
  else
    say "  anillo $VR ($ANILLO): no existe"
  fi
  say "  borde → dial vigente: $(edge_dial | tr '\n' ' ')"
  say "  borde → upstreams: $(edge_upstreams)"
  if [ -f "$RINGS_DIR/rings.json" ]; then
    say "  rings.json → active: $(sed -n 's/^  "active": *"\([^"]*\)".*/\1/p' "$RINGS_DIR/rings.json")"
  fi
  say "  lease → $(cat "$RUN/governance/control.lease.json" 2>/dev/null | tr -d '\n' || echo 'sin archivo')"
}

# ── preparar ───────────────────────────────────────────────────────────────────────────────────────
cmd_preparar() {
  mkdir -p "$RINGS_DIR" "$DATOS" "$RUN/governance" "$CRUDOS"
  docker image inspect "$IMG:$VR" >/dev/null 2>&1 || die "falta la imagen $IMG:$VR (constrúyela desde este worktree)."

  if [ ! -f "$RUN/secreto.env" ]; then
    umask 077
    printf 'VERGIS_CSRF_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$RUN/secreto.env"
  fi
  secreto_cargar

  sed -e "s|@BENCH@|$BENCH|g" -e "s|@SECRETO@|$VERGIS_CSRF_SECRET|g" \
    "$BENCH/rings/ring.args.tmpl" >"$RINGS_DIR/ring.args"

  # El borde arranca apuntando al NODO COMPOSE POR NOMBRE DE SERVICIO — copia literal de
  # `lab/work/231/08-active.caddy`, que es lo que la instancia GH tendrá tras la ventana de la Fase 2.
  printf '# Semilla V-16: el activo es el NODO COMPOSE, ruteado por nombre de servicio.\nreverse_proxy vergis:8080 {\n\timport anillo_activo\n}\n' >"$RINGS_DIR/active.caddy"
  rm -f "$RINGS_DIR/active.caddy.bak" "$RINGS_DIR/rings.json" "$RINGS_DIR/handover.intent.json"
  # Idempotencia (corrida 3): un anillo sobrante de la corrida anterior conserva el lease y el nodo
  # compose nuevo jamás llega a 'serving'. Se retira el anillo; el lease NO se borra: con los stores
  # estampados en una época N, un nodo que arranca sin lease toma una época menor, ve el archivo «ya
  # escrito por la época N» y deshabilita notas y administración por diseño (medido en la corrida 4:
  # 404 en /impresiones que parecían pérdida de datos). Con el lease intacto el sucesor espera el
  # stale window y adquiere con la época correcta.
  docker rm -f "$ANILLO" >/dev/null 2>&1 || true

  say "· levantando el mundo (clickhouse + borde)…"
  $COMPOSE up -d clickhouse caddy >/dev/null

  say "· creando el NODO COMPOSE $NODO (SIN VERGIS_RING, alias de red 'vergis')…"
  docker rm -f "$NODO" >/dev/null 2>&1 || true
  # shellcheck disable=SC2046 # los argumentos de ring.args deben partirse en palabras: es su formato.
  docker create --name "$NODO" --network-alias vergis \
    $(grep -v '^[ ]*#' "$RINGS_DIR/ring.args" | tr '\n' ' ') "$IMG:$VR" >/dev/null
  docker start "$NODO" >/dev/null

  # GUARDA: si el nodo compose llevara identidad de anillo, V-16 estaría midiendo otra cosa.
  if docker inspect --format '{{json .Config.Env}}' "$NODO" | grep -q 'VERGIS_RING'; then
    die "el nodo compose tiene VERGIS_RING: no es el sujeto de V-16."
  fi
  say "  verificado: el nodo compose NO lleva VERGIS_RING ni VERGIS_RING_DIGEST"

  esperar_fase "$NODO" serving 120 || die "el nodo compose no llegó a 'serving'. docker logs $NODO"
  say "  fase del nodo compose: $(fase_de "$NODO" | head -c 160)"

  say "· verificando los 9 PIs por el CONMUTADOR (que es lo que un cliente ve)…"
  docker exec "$NODO" node -e '
    const slugs=[...Array(9)].map((_,i)=>"bench-"+String(i+1).padStart(2,"0"));
    (async()=>{let ok=0;const malos=[];for(const s of slugs){try{const r=await fetch("http://benchv14-caddy:8079/"+s,{headers:{"X-Forwarded-Email":"banco@v14.local"}});if(r.status===200)ok++;else malos.push(s+":"+r.status)}catch(e){malos.push(s+":"+e.name)}}
    console.log(JSON.stringify({pisServidos:ok,de:slugs.length,malos}))})()' | tee "$DATOS/pis-servidos.json"
  say ""
  cmd_estado
  say ""
  say "✓ mundo V-16 listo: activo = NODO COMPOSE sin identidad de anillo, ruteado por 'vergis:8080'."
}

# ── CN del instrumento ─────────────────────────────────────────────────────────────────────────────
# Dos brazos, y ninguno es opcional: contra un nodo EN ESPERA el poller tiene que decir MAL; contra un
# destino inexistente tiene que decir SINMEDIR — nunca OK. Sin esto, cualquier verde de abajo no vale.
cmd_cn_instrumento() {
  segs=${1:-15}
  mkdir -p "$DATOS"
  docker inspect "$ANILLO" >/dev/null 2>&1 || die "CN del instrumento necesita el anillo instalado (corre v16a)."
  say "── CN-instrumento · brazo A: poller DIRECTO al anillo en espera ($ANILLO) ──"
  say "  sujeto ANTES de medir: $(fase_de "$ANILLO" | head -c 160)"
  fase_de "$ANILLO" >"$DATOS/cn-inst-sujeto-antes.txt"
  POLLER_URL="http://$ANILLO:8080/healthz" POLLER_OUT=/datos/v16/cn-inst-standby.jsonl \
    $COMPOSE --profile medicion up -d poller >/dev/null
  ini=$(ahora_ms); i=0; while [ "$i" -lt "$segs" ]; do sleep 1; i=$((i+1)); done; fin=$(ahora_ms)
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  printf '{"inicio":%s,"fin":%s,"etiqueta":"CN-instrumento A · poller directo al anillo EN ESPERA"}\n' "$ini" "$fin" >"$DATOS/cn-inst-standby-ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$DATOS/cn-inst-standby.jsonl" "$DATOS/cn-inst-standby-ventana.json" | tee "$DATOS/cn-inst-standby-veredicto.json"

  say ""
  say "── CN-instrumento · brazo B: poller contra un destino INEXISTENTE ──"
  POLLER_URL="http://benchv14-no-existe:8080/healthz" POLLER_OUT=/datos/v16/cn-inst-nada.jsonl \
    $COMPOSE --profile medicion up -d poller >/dev/null
  ini=$(ahora_ms); i=0; while [ "$i" -lt 8 ]; do sleep 1; i=$((i+1)); done; fin=$(ahora_ms)
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  printf '{"inicio":%s,"fin":%s,"etiqueta":"CN-instrumento B · poller contra un destino inexistente"}\n' "$ini" "$fin" >"$DATOS/cn-inst-nada-ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$DATOS/cn-inst-nada.jsonl" "$DATOS/cn-inst-nada-ventana.json" | tee "$DATOS/cn-inst-nada-veredicto.json"
  say ""
  say "  LECTURA: A pasa con 0 OK y todo MAL (phase=standby). B pasa con 0 OK y todo SINMEDIR."
  say "  Un OK en cualquiera de los dos brazos invalida TODA medición de V-16."
}

# ── V-16a · install con el nodo compose activo ─────────────────────────────────────────────────────
cmd_v16a() {
  mkdir -p "$DATOS"
  secreto_cargar
  say "── V-16a · install $VR con el NODO COMPOSE activo ──"
  cp "$RUN/governance/control.lease.json" "$DATOS/v16a-lease-antes.json" 2>/dev/null || true
  say "  lease ANTES: $(cat "$DATOS/v16a-lease-antes.json" 2>/dev/null | tr -d '\n')"
  set +e
  sh "$TOOL" install "$VR" --no-pull >"$DATOS/v16a-tool.log" 2>&1
  rc=$?
  set -e
  cat "$DATOS/v16a-tool.log"
  say "  (rc=$rc)"
  sleep 2
  cp "$RUN/governance/control.lease.json" "$DATOS/v16a-lease-despues.json" 2>/dev/null || true
  cp "$RINGS_DIR/rings.json" "$DATOS/v16a-rings.json" 2>/dev/null || true
  {
    printf 'rc=%s\n' "$rc"
    printf 'fase nodo compose : %s\n' "$(fase_de "$NODO")"
    printf 'fase anillo %s  : %s\n' "$VR" "$(fase_de "$ANILLO")"
    printf 'lease antes       : %s\n' "$(tr -d '\n' <"$DATOS/v16a-lease-antes.json" 2>/dev/null)"
    printf '\nlease despues     : %s\n' "$(tr -d '\n' <"$DATOS/v16a-lease-despues.json" 2>/dev/null)"
    printf 'borde dial        : %s\n' "$(edge_dial | tr '\n' ' ')"
  } | tee "$DATOS/v16a-resultado.txt"
}

# ── el motor de medición: mismo protocolo que `medir_acto` de bench.sh ─────────────────────────────
# poller + mutador hermanos arriba ANTES, 8 s de línea base, ventana sellada FUERA del acto, veredicto
# computado del crudo. Lo único que cambia entre corridas es el ACTO, que llega como función.
medir() { # medir <id> <etiqueta> <función-del-acto>
  id=$1; etiqueta=$2; acto=$3
  D="$DATOS/$id"; mkdir -p "$D"
  secreto_cargar
  say "── $id · $etiqueta ──"
  cmd_estado
  POLLER_URL=http://benchv14-caddy:8079/healthz
  POLLER_OUT=/datos/v16/$id/poller.jsonl
  MUT_OUT=/datos/v16/$id/mutaciones.jsonl
  export POLLER_URL POLLER_OUT MUT_OUT
  $COMPOSE --profile medicion up -d poller mutador >/dev/null
  say "· instrumento y mutador arriba; 8 s de línea base…"
  sleep 8
  ini=$(ahora_ms)
  set +e
  "$acto" >"$D/acto.log" 2>&1
  rc=$?
  set -e
  fin=$(ahora_ms)
  say "  (rc=$rc · la duración del comando NO es la medición)"
  say "· 12 s de cierre…"
  sleep 12
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  docker exec -e MUT_OUT="$MUT_OUT" -e MUT_URL=http://benchv14-caddy:8079 -e MUT_EMAIL=banco@v14.local \
    benchv14-mutador node /poller/verificar-impresiones.mjs >"$D/impresiones.json" 2>&1 || true
  cat "$D/impresiones.json"
  $COMPOSE --profile medicion stop mutador >/dev/null 2>&1 || true

  docker logs --timestamps "$NODO" >"$D/log-nodo-compose.txt" 2>&1 || true
  docker logs --timestamps "$ANILLO" >"$D/log-anillo.txt" 2>&1 || true
  docker logs --timestamps benchv14-caddy >"$D/log-borde.txt" 2>&1 || true
  cp "$RUN/governance/control.lease.json" "$D/lease-despues.json" 2>/dev/null || true
  cp "$RINGS_DIR/rings.json" "$D/rings.json" 2>/dev/null || true

  printf '{"inicio":%s,"fin":%s,"etiqueta":"%s","rc":%s}\n' "$ini" "$fin" "$etiqueta" "$rc" >"$D/ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$D/poller.jsonl" "$D/ventana.json" "$D/mutaciones.jsonl" | tee "$D/veredicto.json"
  say ""
  cmd_estado
  printf '%s\n' "$rc" >"$D/rc.txt"
}

acto_promote_seco() { sh "$TOOL" promote "$VR"; }

acto_wrapper() {
  ROLLOUT_ENV="$RINGS_DIR/rollout.env" \
  LOG_DIR="$RINGS_DIR" \
  ROLLOUT="sh $TOOL" \
  COMPOSE_NODE="$NODO" \
    sh "$CRUDOS/wrapper-bajo-prueba.sh" "$VR"
}

acto_wrapper_abortado() {
  PRIMERA_TIMEOUT=1 \
  ROLLOUT_ENV="$RINGS_DIR/rollout.env" \
  LOG_DIR="$RINGS_DIR" \
  ROLLOUT="sh $TOOL" \
  COMPOSE_NODE="$NODO" \
    sh "$CRUDOS/wrapper-bajo-prueba.sh" "$VR"
}

# La vuelta atrás MANUAL de la Fase 3 del plan (§5), tal cual está escrita ahí.
acto_vuelta_atras() {
  printf '# Vuelta atrás manual (V-16c): el tráfico primero.\nreverse_proxy vergis:8080 {\n\timport anillo_activo\n}\n' >"$RINGS_DIR/active.caddy"
  docker exec "$RINGS_EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker exec "$RINGS_EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "borde conmutado al nodo compose ($(date -u +%T.%N))"
  docker kill -s USR2 "$ANILLO"
  echo "SIGUSR2 → $ANILLO ($(date -u +%T.%N))"
  i=0
  while [ "$i" -lt 60 ]; do
    case "$(fase_de "$NODO")" in *'"phase":"serving"'*) echo "nodo compose re-adquirió a los ${i}s"; return 0 ;; esac
    sleep 1; i=$((i+1))
  done
  echo "el nodo compose NO volvió a serving en 60 s"; return 1
}

cmd_rollout_env() { # el rollout.env del banco, con la misma forma que `06-rollout.env` de la instancia
  mkdir -p "$RINGS_DIR"
  {
    printf 'RINGS_DIR=%s\n' "$RINGS_DIR"
    printf 'RINGS_IMAGE=%s\n' "$RINGS_IMAGE"
    printf 'RINGS_RETAIN=3\n'
    printf 'RINGS_EDGE=%s\n' "$RINGS_EDGE"
    printf 'RINGS_EDGE_CONFIG=/etc/caddy/Caddyfile\n'
    printf 'RINGS_EDGE_URL=%s\n' "$RINGS_EDGE_URL"
    printf 'RINGS_ADMIN_EMAIL=%s\n' "$RINGS_ADMIN_EMAIL"
    printf 'RINGS_STANDBY_TIMEOUT=90\n'
    printf 'RINGS_PROMOTE_TIMEOUT=10\n'
  } >"$RINGS_DIR/rollout.env"
}

cmd_rss() {
  mkdir -p "$DATOS"
  say "── V-RSS · los dos nodos sirviendo (docker stats, una muestra) ──"
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' "$NODO" "$ANILLO" benchv14-caddy | tee "$DATOS/rss.txt"
  say ""
  say "  límite de memoria declarado por contenedor:"
  for c in "$NODO" "$ANILLO"; do
    printf '  %s → %s bytes\n' "$c" "$(docker inspect --format '{{.HostConfig.Memory}}' "$c")"
  done | tee -a "$DATOS/rss.txt"
}

case "${1:-}" in
preparar) shift; cmd_rollout_env; cmd_preparar "$@" ;;
estado) shift; cmd_estado "$@" ;;
cn-instrumento) shift; cmd_cn_instrumento "$@" ;;
v16a) shift; cmd_v16a "$@" ;;
v16b-cn) shift; medir v16b-cn "V-16b CONTROL NEGATIVO · promote A SECAS con el activo sin identidad de anillo" acto_promote_seco ;;
v16b) shift; medir v16b "V-16b · primera promocion CON wrapper (SIGUSR2 al nodo compose)" acto_wrapper ;;
v16c) shift; medir v16c "V-16c · vuelta atras manual: anillo -> nodo compose" acto_vuelta_atras ;;
v16d) shift; medir v16d "V-16d · promocion abortada a proposito (timeout 1 s, sin senal)" acto_wrapper_abortado ;;
rss) shift; cmd_rss "$@" ;;
*) die "uso: $0 {preparar|estado|cn-instrumento [segs]|v16a|v16b-cn|v16b|v16c|v16d|rss}" ;;
esac
