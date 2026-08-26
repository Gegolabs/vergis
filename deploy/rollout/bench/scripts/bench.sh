#!/bin/sh
# bench.sh — orquestador del BANCO V-14: el arnés que mide una promoción de anillos de punta a punta.
#
# Contrato: `lab/work/225` §7. Lo que este script garantiza y ningún log puede reemplazar:
#
#   · el poller y el mutador viven en contenedores HERMANOS que el acto NO recrea, y se levantan
#     ANTES del acto y se bajan DESPUÉS;
#   · la ventana del acto se sella con dos timestamps tomados FUERA del acto (el comando miente);
#   · el veredicto se computa del archivo crudo, jamás de la consola;
#   · todo recurso lleva prefijo `benchv14-`, y ningún comando destructivo de acá alcanza otra cosa.
#
# POSIX sh estricto (mismo criterio que `vergis-rollout`: la herramienta se corre con `sh`).
#
# Uso:
#   sh scripts/bench.sh preparar            levanta el mundo y deja dos anillos (activo + espera)
#   sh scripts/bench.sh cn1 [segundos]      CONTROL NEGATIVO DEL INSTRUMENTO
#   sh scripts/bench.sh cn2                 CONTROL NEGATIVO DEL MECANISMO (promoción, orden vigente)
#   sh scripts/bench.sh estado              qué hay vivo y a quién apunta el borde (leído del sujeto)
#   sh scripts/bench.sh limpiar             baja y borra TODO lo `benchv14-` (nada más)
#   sh scripts/bench.sh todo                preparar + cn1 + cn2
#   sh scripts/bench.sh v14 <id> [promote|rollback]   V-14: el acto bajo el ORDEN NUEVO (flip-first)
#   sh scripts/bench.sh carrera [N]         N promociones seguidas: la carrera del lease bajo el intent
#   sh scripts/bench.sh reposo <id> [segs]  poller SIN acto: la carga del health check en la aguja

set -eu

BENCH=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$BENCH/../../.." && pwd)
TOOL="$REPO/deploy/rollout/vergis-rollout"
RUN="$BENCH/.run"
DATOS="$RUN/datos"
COMPOSE="docker compose -f $BENCH/compose.bench.yml"

V1=9.9.1
V2=9.9.2
IMG=benchv14/vergis

# La herramienta apunta al mundo del banco. Nada de esto toca la VM ni un despliegue real.
RINGS_DIR="$RUN/rings"
RINGS_IMAGE="$IMG"
RINGS_EDGE=benchv14-caddy
RINGS_EDGE_URL=http://benchv14-caddy:8079
export RINGS_DIR RINGS_IMAGE RINGS_EDGE RINGS_EDGE_URL

say() { printf '%s\n' "$*"; }
die() { printf 'bench: %s\n' "$*" >&2; exit 1; }
ahora_ms() { date +%s000; }

# ── Estado VIVO, leído del sujeto y no del archivo ──────────────────────────────────────────────────
# Regla 3 de `ww:wingcoding`: una edición in-place cambia el inodo y el bind-mount puede seguir viendo
# lo anterior. Lo que el borde REALMENTE rutea se le pregunta a su admin API; la fase de un nodo, a su
# propio healthz. Un control negativo que salga verde-inesperado se sospecha del transporte, y esta
# función es lo que permite sospecharlo con datos.
edge_upstreams() {
  docker exec "$RINGS_EDGE" wget -q -O- "http://127.0.0.1:2019/reverse_proxy/upstreams" 2>/dev/null || printf '[]'
}
edge_config_activa() {
  docker exec "$RINGS_EDGE" wget -q -O- "http://127.0.0.1:2019/config/" 2>/dev/null || printf '{}'
}
fase_de() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const b=await r.text();process.stdout.write(r.status+' '+b)}).catch(()=>process.stdout.write('sin-respuesta'))" 2>/dev/null || printf 'sin-respuesta'
}
nombre_de() { printf 'vergis-%s\n' "$(printf '%s' "$1" | tr '.' '-')"; }

activo_vivo() {
  for v in "$V1" "$V2"; do
    n=$(nombre_de "$v")
    if [ "$(docker inspect --format '{{.State.Running}}' "$n" 2>/dev/null || echo false)" = true ]; then
      case "$(fase_de "$n")" in *'"phase":"serving"'*) printf '%s\n' "$v"; return 0 ;; esac
    fi
  done
  printf '\n'
}

# ── preparar ───────────────────────────────────────────────────────────────────────────────────────
cmd_preparar() {
  mkdir -p "$RINGS_DIR" "$DATOS" "$RUN/governance"

  if ! docker image inspect "$IMG:$V1" >/dev/null 2>&1; then
    say "· construyendo la imagen del banco desde ESTE worktree (main de hoy)…"
    docker build -t "$IMG:$V1" "$REPO" >"$RUN/build.log" 2>&1 || die "el build falló: mira $RUN/build.log"
  fi
  docker tag "$IMG:$V1" "$IMG:$V2"
  say "· imagen: $IMG:$V1 y $IMG:$V2 (MISMO contenido a propósito — el sujeto es el ACTO, no el delta)"

  # Secreto CSRF de la corrida: compartido por los anillos, generado al vuelo, jamás versionado.
  if [ ! -f "$RUN/secreto.env" ]; then
    umask 077
    printf 'VERGIS_CSRF_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$RUN/secreto.env"
  fi
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET

  sed -e "s|@BENCH@|$BENCH|g" -e "s|@SECRETO@|$VERGIS_CSRF_SECRET|g" \
    "$BENCH/rings/ring.args.tmpl" >"$RINGS_DIR/ring.args"
  [ -f "$RINGS_DIR/active.caddy" ] || cp "$BENCH/rings/active.caddy.seed" "$RINGS_DIR/active.caddy"

  say "· levantando el mundo (clickhouse + borde)…"
  $COMPOSE up -d clickhouse caddy >/dev/null

  say "· instalando anillos (sin pull: la imagen es local)…"
  sh "$TOOL" install "$V1" --no-pull
  # El primer `promote` fija el borde en el anillo que ya tiene el control: es idempotente y deja el
  # registro coherente con lo observado.
  sh "$TOOL" promote "$V1" --no-schema-gate
  sh "$TOOL" install "$V2" --no-pull

  cmd_estado
  say ""
  say "· verificando cuántos PIs sirve el arnés (índice del anillo activo)…"
  act=$(activo_vivo)
  [ -n "$act" ] || die "no hay anillo con el plano de control tras preparar."
  n=$(nombre_de "$act")
  docker exec "$n" node -e '
    const slugs=[...Array(9)].map((_,i)=>"bench-"+String(i+1).padStart(2,"0"));
    (async()=>{let ok=0;const malos=[];for(const s of slugs){try{const r=await fetch("http://127.0.0.1:8080/"+s,{headers:{"X-Forwarded-Email":"banco@v14.local"}});if(r.status===200)ok++;else malos.push(s+":"+r.status)}catch(e){malos.push(s+":"+e.name)}}
    console.log(JSON.stringify({pisServidos:ok,de:slugs.length,malos}))})()' | tee "$DATOS/pis-servidos.json"
  say ""
  say "✓ banco listo. Activo: $act · en espera: el otro anillo."
}

# ── estado ─────────────────────────────────────────────────────────────────────────────────────────
cmd_estado() {
  say "── estado VIVO (leído del sujeto, no de los archivos) ──"
  for v in "$V1" "$V2"; do
    n=$(nombre_de "$v")
    say "  $v ($n): $(fase_de "$n" | head -c 200)"
  done
  say "  borde → upstreams: $(edge_upstreams)"
  say "  borde → línea vigente en la config viva:"
  edge_config_activa | tr ',' '\n' | grep -i "dial" || say "    (sin campo dial visible)"
}

# ── CN-1 · control negativo DEL INSTRUMENTO ────────────────────────────────────────────────────────
# Se apunta el poller DIRECTO a un nodo en espera. DEBE reportar fuera-de-predicado. Un poller que no
# sabe ver el fallo produce el dato con cara de verdad que ya costó dos mediciones ciegas.
cmd_cn1() {
  segs=${1:-20}
  mkdir -p "$DATOS"
  act=$(activo_vivo)
  [ -n "$act" ] || die "CN-1 no se corre sin un activo: haría falso el contraste."
  if [ "$act" = "$V1" ]; then espera=$V2; else espera=$V1; fi
  ne=$(nombre_de "$espera")
  na=$(nombre_de "$act")

  say "── CN-1 · el instrumento contra un nodo EN ESPERA ($espera / $ne) ──"
  say "  estado vivo del sujeto ANTES de medir:"
  say "    en espera → $(fase_de "$ne" | head -c 160)"
  say "    activo    → $(fase_de "$na" | head -c 160)"
  fase_de "$ne" >"$DATOS/cn1-sujeto-antes.txt"

  POLLER_URL="http://$ne:8080/healthz"
  POLLER_OUT=/datos/cn1-poller.jsonl
  export POLLER_URL POLLER_OUT
  $COMPOSE --profile medicion up -d poller >/dev/null
  ini=$(ahora_ms)
  i=0; while [ "$i" -lt "$segs" ]; do sleep 1; i=$((i+1)); done
  fin=$(ahora_ms)
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true

  printf '{"inicio":%s,"fin":%s,"etiqueta":"CN-1 · poller directo a un nodo en espera"}\n' "$ini" "$fin" >"$DATOS/cn1-ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$DATOS/cn1-poller.jsonl" "$DATOS/cn1-ventana.json" | tee "$DATOS/cn1-veredicto.json"
  say ""
  say "  LECTURA: CN-1 pasa si TODAS las muestras son fuera-de-predicado (MAL, phase=standby)."
  say "  Si sale verde, se sospecha del TRANSPORTE antes que del mecanismo: ¿el poller apuntó a quien creía?"
}

# ── CN-2 · control negativo DEL MECANISMO ──────────────────────────────────────────────────────────
# Una promoción con el ORDEN VIGENTE (handover → flip) bajo el mismo poller. DEBE reproducir el tramo
# (a): respuestas `200 ∧ phase=standby`. Si no lo reproduce, no se fuerza ni se declara verde.
cmd_cn2() {
  mkdir -p "$DATOS"
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET
  act=$(activo_vivo)
  [ -n "$act" ] || die "CN-2 necesita un activo vivo. Corre 'preparar'."
  if [ "$act" = "$V1" ]; then cand=$V2; else cand=$V1; fi
  say "── CN-2 · promoción con el ORDEN VIGENTE: $act → $cand ──"
  cmd_estado

  POLLER_URL=http://benchv14-caddy:8079/healthz
  POLLER_OUT=/datos/cn2-poller.jsonl
  MUT_OUT=/datos/cn2-mutaciones.jsonl
  export POLLER_URL POLLER_OUT MUT_OUT
  $COMPOSE --profile medicion up -d poller mutador >/dev/null
  say "· instrumento y mutador arriba; 8 s de línea base antes de tocar nada…"
  sleep 8

  ini=$(ahora_ms)
  say "· ACTO: sh vergis-rollout promote $cand   (t0=$ini)"
  set +e
  sh "$TOOL" promote "$cand" --no-schema-gate >"$DATOS/cn2-tool.log" 2>&1
  rc=$?
  set -e
  fin=$(ahora_ms)
  say "  (rc=$rc · la duración del comando NO es la medición: mira el poller)"
  say "· 10 s de cierre para que los retenidos terminen…"
  sleep 10

  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  say "· verificando cero-pérdidas de las mutaciones…"
  docker exec -e MUT_OUT="$MUT_OUT" -e MUT_URL=http://benchv14-caddy:8079 -e MUT_EMAIL=banco@v14.local \
    benchv14-mutador node /poller/verificar-impresiones.mjs >"$DATOS/cn2-impresiones.json" 2>&1 || true
  cat "$DATOS/cn2-impresiones.json"
  $COMPOSE --profile medicion stop mutador >/dev/null 2>&1 || true

  # Tramos internos: los logs de ambos nodos y del borde, con marca de tiempo. Son los que convierten
  # la expectativa en cifras o la desmienten (§7, último bullet).
  docker logs --timestamps "$(nombre_de "$act")" >"$DATOS/cn2-log-viejo.txt" 2>&1 || true
  docker logs --timestamps "$(nombre_de "$cand")" >"$DATOS/cn2-log-candidato.txt" 2>&1 || true
  docker logs --timestamps benchv14-caddy >"$DATOS/cn2-log-borde.txt" 2>&1 || true

  printf '{"inicio":%s,"fin":%s,"etiqueta":"CN-2 · promocion orden VIGENTE (handover -> flip) %s -> %s"}\n' \
    "$ini" "$fin" "$act" "$cand" >"$DATOS/cn2-ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$DATOS/cn2-poller.jsonl" "$DATOS/cn2-ventana.json" "$DATOS/cn2-mutaciones.jsonl" | tee "$DATOS/cn2-veredicto.json"
  say ""
  cmd_estado
  say ""
  say "  LECTURA: CN-2 REPRODUCE si tramoA.respuestas200Standby > 0."
  say "  Si es 0, NO se fuerza y NO se declara verde: se reporta «CN-2 no reproduce» con el crudo."
}


# ── medir_acto · el motor de una corrida V-14 ──────────────────────────────────────────────────────
# Mismo protocolo que CN-2 (misma ventana sellada fuera del acto, mismo instrumento hermano, mismo
# veredicto computado del crudo) con UNA diferencia: el acto que corre es el de ESTE worktree, o sea el
# ORDEN NUEVO (flip → handover dirigido). Cada corrida escribe en su propio subdirectorio para que
# ningún crudo pise al de la corrida anterior.
#
# `accion` es `promote` o `rollback`: el contrato pide medir el espejo APARTE, porque «es el mismo
# código» no es una medición.
medir_acto() {
  id=$1
  accion=${2:-promote}
  D="$DATOS/$id"
  mkdir -p "$D"
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET
  act=$(activo_vivo)
  [ -n "$act" ] || die "$id necesita un activo vivo. Corre 'preparar'."
  if [ "$act" = "$V1" ]; then cand=$V2; else cand=$V1; fi
  say "── $id · $accion con el ORDEN NUEVO (flip-first): $act → $cand ──"

  POLLER_URL=http://benchv14-caddy:8079/healthz
  POLLER_OUT=/datos/$id/poller.jsonl
  MUT_OUT=/datos/$id/mutaciones.jsonl
  export POLLER_URL POLLER_OUT MUT_OUT
  $COMPOSE --profile medicion up -d poller mutador >/dev/null
  say "· instrumento y mutador arriba; 8 s de línea base antes de tocar nada…"
  sleep 8

  ini=$(ahora_ms)
  if [ "$accion" = rollback ]; then
    say "· ACTO: sh vergis-rollout rollback $cand   (t0=$ini)"
    set +e
    sh "$TOOL" rollback "$cand" >"$D/tool.log" 2>&1
    rc=$?
    set -e
  else
    say "· ACTO: sh vergis-rollout promote $cand   (t0=$ini)"
    set +e
    sh "$TOOL" promote "$cand" --no-schema-gate >"$D/tool.log" 2>&1
    rc=$?
    set -e
  fi
  fin=$(ahora_ms)
  say "  (rc=$rc · la duración del comando NO es la medición: mira el poller)"
  say "· 10 s de cierre para que los retenidos terminen…"
  sleep 10

  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  say "· verificando cero-pérdidas de las mutaciones…"
  docker exec -e MUT_OUT="$MUT_OUT" -e MUT_URL=http://benchv14-caddy:8079 -e MUT_EMAIL=banco@v14.local \
    benchv14-mutador node /poller/verificar-impresiones.mjs >"$D/impresiones.json" 2>&1 || true
  cat "$D/impresiones.json"
  $COMPOSE --profile medicion stop mutador >/dev/null 2>&1 || true

  docker logs --timestamps "$(nombre_de "$act")" >"$D/log-viejo.txt" 2>&1 || true
  docker logs --timestamps "$(nombre_de "$cand")" >"$D/log-candidato.txt" 2>&1 || true
  docker logs --timestamps benchv14-caddy >"$D/log-borde.txt" 2>&1 || true

  printf '{"inicio":%s,"fin":%s,"etiqueta":"%s · %s orden NUEVO (flip-first) %s -> %s","rc":%s}\n' \
    "$ini" "$fin" "$id" "$accion" "$act" "$cand" "$rc" >"$D/ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$D/poller.jsonl" "$D/ventana.json" "$D/mutaciones.jsonl" | tee "$D/veredicto.json"
  say ""
  say "  LECTURA: el criterio DURO de V-14 es fueraDePredicado == 0. Una sola respuesta 200∧standby o"
  say "  un 503 se reporta con su crudo y REFUTA C-1/C-2 — no se explica ni se suaviza."
}

cmd_v14() {
  [ $# -ge 1 ] || die "uso: $0 v14 <id> [promote|rollback]"
  medir_acto "$@"
}

# ── carrera · la carrera del lease en N promociones seguidas ───────────────────────────────────────
# Criterio del contrato (§8): 0 `warn` de `insistir_handover` —el detector de que el intent no ordenó
# la fila— y 0 fuera-de-predicado agregado en toda la serie. El poller cubre la serie ENTERA: la
# ventana se sella con el t0 del primer acto y el t1 del último, y el veredicto se computa del crudo.
cmd_carrera() {
  n=${1:-20}
  id=carrera
  D="$DATOS/$id"
  mkdir -p "$D"
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET

  POLLER_URL=http://benchv14-caddy:8079/healthz
  POLLER_OUT=/datos/$id/poller.jsonl
  MUT_OUT=/datos/$id/mutaciones.jsonl
  export POLLER_URL POLLER_OUT MUT_OUT
  $COMPOSE --profile medicion up -d poller mutador >/dev/null
  say "· instrumento arriba; 5 s de línea base…"
  sleep 5

  ini=$(ahora_ms)
  i=1
  while [ "$i" -le "$n" ]; do
    act=$(activo_vivo)
    [ -n "$act" ] || die "carrera: no hay activo vivo en la iteración $i. Se detiene y se reporta."
    if [ "$act" = "$V1" ]; then cand=$V2; else cand=$V1; fi
    say "· carrera $i/$n: $act → $cand"
    set +e
    sh "$TOOL" promote "$cand" --no-schema-gate >"$D/tool-$i.log" 2>&1
    rc=$?
    set -e
    [ "$rc" = 0 ] || say "  ⚠ iteración $i devolvió rc=$rc (el log queda en tool-$i.log)"
    sleep 3
    i=$((i + 1))
  done
  fin=$(ahora_ms)
  say "· 10 s de cierre…"
  sleep 10
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  docker exec -e MUT_OUT="$MUT_OUT" -e MUT_URL=http://benchv14-caddy:8079 -e MUT_EMAIL=banco@v14.local \
    benchv14-mutador node /poller/verificar-impresiones.mjs >"$D/impresiones.json" 2>&1 || true
  cat "$D/impresiones.json"
  $COMPOSE --profile medicion stop mutador >/dev/null 2>&1 || true

  docker logs --timestamps "$(nombre_de "$V1")" >"$D/log-9.9.1.txt" 2>&1 || true
  docker logs --timestamps "$(nombre_de "$V2")" >"$D/log-9.9.2.txt" 2>&1 || true

  printf '{"inicio":%s,"fin":%s,"etiqueta":"carrera del lease · %s promociones seguidas, orden NUEVO"}\n' \
    "$ini" "$fin" "$n" >"$D/ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$D/poller.jsonl" "$D/ventana.json" "$D/mutaciones.jsonl" | tee "$D/veredicto.json"

  say ""
  say "· warns de carrera del lease, CONTADOS de los logs de la herramienta (no asumidos):"
  grep -c "el control lo tomó" "$D"/tool-*.log | tee "$D/warns-por-corrida.txt" || true
  say "  TOTAL insistir_handover warns: $(cat "$D"/tool-*.log | grep -c "el control lo tomó" || true)"
}

# ── reposo · la carga del health check, sin acto ───────────────────────────────────────────────────
# Mide la latencia del poller contra el conmutador SIN que ocurra nada. Es la aguja que el contrato
# (§5, §8) pide comparar entre `health_interval` de 1 s y de 250 ms: 4 req/s × upstream contra
# `/healthz` deben ser despreciables, y «despreciable» es una cifra o no es nada.
cmd_reposo() {
  id=${1:-reposo}
  segs=${2:-30}
  D="$DATOS/$id"
  mkdir -p "$D"
  say "── $id · poller en reposo, ${segs}s ──"
  say "  intervalo de salud VIVO (leído del sujeto, admin API :2019):"
  edge_config_activa | tr ',' '\n' | grep -i "interval" || say "    (sin campo interval visible)"
  edge_config_activa >"$D/config-viva.json"

  POLLER_URL=http://benchv14-caddy:8079/healthz
  POLLER_OUT=/datos/$id/poller.jsonl
  export POLLER_URL POLLER_OUT
  $COMPOSE --profile medicion up -d poller >/dev/null
  ini=$(ahora_ms)
  i=0; while [ "$i" -lt "$segs" ]; do sleep 1; i=$((i+1)); done
  fin=$(ahora_ms)
  $COMPOSE --profile medicion stop poller >/dev/null 2>&1 || true
  printf '{"inicio":%s,"fin":%s,"etiqueta":"%s · poller en reposo (sin acto)"}\n' "$ini" "$fin" "$id" >"$D/ventana.json"
  node "$BENCH/scripts/veredicto.mjs" "$D/poller.jsonl" "$D/ventana.json" | tee "$D/veredicto.json"
}

# ── limpiar ────────────────────────────────────────────────────────────────────────────────────────
# Acotado por NOMBRE a lo `benchv14-` y a los dos anillos del banco. Sin `-v` sobre nada ajeno.
cmd_limpiar() {
  for v in "$V1" "$V2"; do docker rm -f "$(nombre_de "$v")" >/dev/null 2>&1 || true; done
  $COMPOSE --profile medicion down >/dev/null 2>&1 || true
  say "✓ banco abajo (anillos del banco y servicios benchv14-*). Los datos crudos quedan en $DATOS."
}

case "${1:-}" in
preparar) shift; cmd_preparar "$@" ;;
estado) shift; cmd_estado "$@" ;;
cn1) shift; cmd_cn1 "$@" ;;
cn2) shift; cmd_cn2 "$@" ;;
v14) shift; cmd_v14 "$@" ;;
carrera) shift; cmd_carrera "$@" ;;
reposo) shift; cmd_reposo "$@" ;;
limpiar) shift; cmd_limpiar "$@" ;;
todo) cmd_preparar; cmd_cn1; cmd_cn2 ;;
*) die "uso: $0 {preparar|estado|cn1 [segundos]|cn2|v14 <id> [promote|rollback]|carrera [N]|reposo <id> [segs]|limpiar|todo}" ;;
esac
