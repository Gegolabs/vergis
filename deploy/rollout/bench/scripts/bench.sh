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
# Identidad admin con la que el pre-flight lee `/contrato` del candidato. Es el MISMO correo que
# `VERGIS_ADMIN_SEED` en `rings/ring.args.tmpl`: sin ella el gate de esquema no puede medir y aborta.
RINGS_ADMIN_EMAIL=banco@v14.local
export RINGS_DIR RINGS_IMAGE RINGS_EDGE RINGS_EDGE_URL RINGS_ADMIN_EMAIL

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
    # CON gate de esquema. Antes iba `--no-schema-gate` porque la instancia del banco no tenia store
    # de gobierno: /contrato respondia 403 y el gate ABORTABA el pre-flight, y un aborto no mueve nada
    # — de ahi salia «0 fuera de predicado» sin haber medido acto alguno, el verde que no midio.
    # Con `VERGIS_ADMIN_SEED` en `ring.args.tmpl` el store existe y el gate se ejerce de verdad (V11).
    sh "$TOOL" rollback "$cand" >"$D/tool.log" 2>&1
    rc=$?
    set -e
  else
    say "· ACTO: sh vergis-rollout promote $cand   (t0=$ini)"
    set +e
    sh "$TOOL" promote "$cand" >"$D/tool.log" 2>&1
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


# ════════════════════════════════════════════════════════════════════════════════════════════════════
# ARNÉS V2–V13 (`work/209` §3 y `work/210` §10) — lo que el banco no medía todavía.
#
# Regla común a todos: cada V trae SU CONTROL NEGATIVO en el mismo comando, y ninguno se declara verde
# sin él. Un control negativo que sale verde manda a sospechar del transporte, no del mecanismo.
# ════════════════════════════════════════════════════════════════════════════════════════════════════

# Sonda de MUTACIÓN contra un anillo NOMBRADO, disparada desde el otro anillo (misma red, sin pasar por
# el borde: V2 pregunta por el nodo, no por el conmutador). `POST /<pi>/imprimir` es la misma mutación
# gobernada del mutador — pasa por `mutacionSinControl` en `server/routes.ts`.
# shellcheck disable=SC2016  # es código JS con template literals, no expansión de shell
MUTAR_JS='const [dest,pi,email,csrf]=process.argv.slice(1);fetch(`http://${dest}:8080/${pi}/imprimir`,{method:"POST",headers:{"content-type":"application/json","X-Forwarded-Email":email},body:JSON.stringify({_csrf:csrf})}).then(async r=>{const b=await r.text();process.stdout.write(r.status+" "+b.replace(/\s+/g," ").slice(0,220))}).catch(e=>process.stdout.write("sin-respuesta "+e.name))'
# Control negativo del mismo canal: un GET (método seguro) al MISMO nodo. Si el standby estuviera
# simplemente roto o incomunicado, esto también fallaría — y el 409 no probaría nada del plano de control.
# shellcheck disable=SC2016  # es código JS con template literals, no expansión de shell
LEER_JS='const [dest,pi,email]=process.argv.slice(1);fetch(`http://${dest}:8080/${pi}`,{headers:{"X-Forwarded-Email":email}}).then(async r=>{const b=await r.text();process.stdout.write(r.status+" bytes="+b.length)}).catch(e=>process.stdout.write("sin-respuesta "+e.name))'

secreto_cargar() {
  # shellcheck disable=SC1091
  . "$RUN/secreto.env"
  export VERGIS_CSRF_SECRET
}
csrf_de() {
# shellcheck disable=SC2016  # es código JS con template literals, no expansión de shell
  node -e 'const{createHmac}=require("node:crypto");process.stdout.write(createHmac("sha256",process.env.VERGIS_CSRF_SECRET).update(`vergis-csrf|${process.argv[1]}`).digest("hex").slice(0,24))' "$1"
}
contrato_de() {
  docker exec "$1" node -e 'fetch("http://127.0.0.1:8080/contrato",{headers:{"X-Forwarded-Email":process.argv[1]}}).then(async r=>process.stdout.write(r.status+" "+await r.text())).catch(()=>process.stdout.write("sin-respuesta"))' "$RINGS_ADMIN_EMAIL" 2>/dev/null || printf 'sin-respuesta'
}

# ── V2 · el lease es EXCLUSIVO ─────────────────────────────────────────────────────────────────────
# Dos nodos vivos, una mutación de gobierno a CADA UNO, directo (no por el conmutador):
#   activo  → 200   ·   standby → 409 EXPLÍCITO nombrando al activo.
# CONTROL NEGATIVO: un GET al mismo standby tiene que responder 200 con cuerpo. Sin ese brazo, un 409
# por un nodo caído o incomunicado sería indistinguible del 409 del plano de control.
cmd_v2() {
  D="$DATOS/v2"; mkdir -p "$D"; secreto_cargar
  act=$(activo_vivo); [ -n "$act" ] || die "V2 necesita un activo vivo. Corre 'preparar'."
  if [ "$act" = "$V1" ]; then esp=$V2; else esp=$V1; fi
  na=$(nombre_de "$act"); ne=$(nombre_de "$esp")
  tok=$(csrf_de banco@v14.local)
  say "── V2 · lease exclusivo · activo=$act ($na) · standby=$esp ($ne) ──"
  say "  estado VIVO del sujeto antes de mutar:"
  say "    activo  → $(fase_de "$na" | head -c 120)"
  say "    standby → $(fase_de "$ne" | head -c 120)"

  # La mutación se dispara DESDE el otro anillo: nadie muta contra sí mismo por localhost.
  r_act=$(docker exec "$ne" node -e "$MUTAR_JS" "$na" bench-01 banco@v14.local "$tok" 2>&1)
  r_esp=$(docker exec "$na" node -e "$MUTAR_JS" "$ne" bench-01 banco@v14.local "$tok" 2>&1)
  cn_esp=$(docker exec "$na" node -e "$LEER_JS" "$ne" bench-01 banco@v14.local 2>&1)
  cn_act=$(docker exec "$ne" node -e "$LEER_JS" "$na" bench-01 banco@v14.local 2>&1)

  say ""
  say "  MUTACIÓN → activo  ($na): $r_act"
  say "  MUTACIÓN → standby ($ne): $r_esp"
  say "  CONTROL NEGATIVO · LECTURA → standby ($ne): $cn_esp"
  say "  CONTROL NEGATIVO · LECTURA → activo  ($na): $cn_act"

  ok_act=$(printf '%s' "$r_act" | grep -c '^200 .*"ok":true' || true)
  ok_esp=$(printf '%s' "$r_esp" | grep -c '^409 ' || true)
  nombra=$(printf '%s' "$r_esp" | grep -c 'nodo activo es' || true)
  cn_ok=$(printf '%s' "$cn_esp" | grep -c '^200 bytes=' || true)
  {
    printf '{"v":"V2","activo":"%s","standby":"%s",' "$act" "$esp"
    printf '"mutacionActivo":%s,"mutacionStandby":%s,' "$(printf '%s' "$r_act" | sed 's/"/\\"/g;s/^/"/;s/$/"/')" "$(printf '%s' "$r_esp" | sed 's/"/\\"/g;s/^/"/;s/$/"/')"
    printf '"cnLecturaStandby":%s,"cnLecturaActivo":%s,' "$(printf '%s' "$cn_esp" | sed 's/"/\\"/g;s/^/"/;s/$/"/')" "$(printf '%s' "$cn_act" | sed 's/"/\\"/g;s/^/"/;s/$/"/')"
    printf '"activo200":%s,"standby409":%s,"409NombraAlActivo":%s,"cnLecturaStandby200":%s}\n' "$ok_act" "$ok_esp" "$nombra" "$cn_ok"
  } >"$D/resultado.json"
  cat "$D/resultado.json"
  say ""
  if [ "$ok_act" = 1 ] && [ "$ok_esp" = 1 ] && [ "$nombra" = 1 ] && [ "$cn_ok" = 1 ]; then
    say "  V2 PASA · el activo escribe (200), el standby se niega con 409 nombrando al activo, y su"
    say "  control negativo demuestra que el standby SÍ responde: el 409 es del plano de control."
  else
    say "  V2 NO PASA con estos brazos. No se explica ni se suaviza: mira $D/resultado.json"
  fi
}

# ── V3 · el standby NO controla ────────────────────────────────────────────────────────────────────
# Observación ≥5 min con los dos nodos vivos: se muestrea `/contrato` de ambos y se cuentan los TICKS
# de cada lazo. El criterio es una asimetría medida, no una lectura de código: los lazos del activo
# tienen que TICKEAR y los del standby quedarse en cero, con `loops.armed` true/false respectivamente.
# CONTROL NEGATIVO: si el instrumento no viera ningún tick en NINGÚN lado, el cero del standby no
# significaría nada — por eso el veredicto exige ticks>0 en el activo dentro de la misma ventana.
cmd_v3() {
  D="$DATOS/v3"; mkdir -p "$D"
  segs=${1:-330}
  act=$(activo_vivo); [ -n "$act" ] || die "V3 necesita un activo vivo."
  if [ "$act" = "$V1" ]; then esp=$V2; else esp=$V1; fi
  na=$(nombre_de "$act"); ne=$(nombre_de "$esp")
  say "── V3 · el standby no controla · ${segs}s de observación · activo=$act · standby=$esp ──"
  : >"$D/muestras.jsonl"
  t0=$(ahora_ms)
  i=0
  while [ "$i" -lt "$segs" ]; do
    ca=$(contrato_de "$na"); ce=$(contrato_de "$ne")
    node -e '
      const [t,rolA,a,rolE,e]=process.argv.slice(1)
      const cortar=(s)=>{const i=s.indexOf(" ");return [s.slice(0,i),s.slice(i+1)]}
      const leer=(s)=>{try{const [st,b]=cortar(s);const j=JSON.parse(b);const c=j.control;return{status:Number(st),armed:c.loops.armed,ticks:Object.fromEntries(c.loops.detail.map(l=>[l.name,l.ticks])),held:c.lease.held,epoch:c.lease.epoch,modos:Object.fromEntries(c.store.map(s=>[s.name,s.mode])),degraded:c.store.some(s=>s.degraded)}}catch{return{error:s.slice(0,80)}}}
      process.stdout.write(JSON.stringify({t:Number(t),[rolA]:leer(a),[rolE]:leer(e)})+"\n")
    ' "$(ahora_ms)" activo "$ca" standby "$ce" >>"$D/muestras.jsonl"
    sleep 15
    i=$((i + 15))
  done
  t1=$(ahora_ms)
  docker logs --timestamps "$na" >"$D/log-activo.txt" 2>&1 || true
  docker logs --timestamps "$ne" >"$D/log-standby.txt" 2>&1 || true
  printf '{"inicio":%s,"fin":%s,"etiqueta":"V3 · observación de lazos con dos nodos vivos"}\n' "$t0" "$t1" >"$D/ventana.json"
  node -e '
    const fs=require("node:fs")
    const m=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    const suma=(rol)=>{const u={};for(const s of m){const t=s[rol]?.ticks??{};for(const k of Object.keys(t))u[k]=Math.max(u[k]??0,t[k])}return u}
    // DELTA dentro de la ventana: el acumulado puede venir de antes de empezar a mirar. Lo que prueba
    // que un lazo está VIVO en esta ventana es que su contador SUBA mientras la ventana está abierta.
    const delta=(rol)=>{const pri=m[0][rol]?.ticks??{},ult=m.at(-1)[rol]?.ticks??{};const u={};for(const k of Object.keys(ult))u[k]=(ult[k]??0)-(pri[k]??0);return u}
    const armed=(rol)=>[...new Set(m.map(s=>s[rol]?.armed))]
    const modos=(rol)=>[...new Set(m.map(s=>JSON.stringify(s[rol]?.modos)))]
    const held=(rol)=>[...new Set(m.map(s=>s[rol]?.held))]
    const deg=(rol)=>[...new Set(m.map(s=>s[rol]?.degraded))]
    const ta=suma("activo"), te=suma("standby")
    const da=delta("activo"), de=delta("standby")
    const ticksActivo=Object.values(da).reduce((a,b)=>a+b,0)
    const ticksStandby=Object.values(de).reduce((a,b)=>a+b,0)
    const r={v:"V3",muestras:m.length,ventanaSeg:Math.round((m.at(-1).t-m[0].t)/1000),
      activo:{armed:armed("activo"),held:held("activo"),ticksAcumulados:ta,ticksEnLaVentana:da,totalTicksEnLaVentana:ticksActivo,modosStore:modos("activo"),degraded:deg("activo")},
      standby:{armed:armed("standby"),held:held("standby"),ticksAcumulados:te,ticksEnLaVentana:de,totalTicksEnLaVentana:ticksStandby,modosStore:modos("standby"),degraded:deg("standby")},
      veredicto: ticksActivo>0 && ticksStandby===0 && armed("activo").join()==="true" && armed("standby").join()==="false"
        ? "V3 PASA · un solo plano de control vivo: los lazos ticksan SOLO en el activo (y el control negativo del propio instrumento es que SÍ vio ticks)"
        : ticksActivo===0 ? "V3 NO CONCLUYE · el instrumento no vio un solo tick en la ventana: el cero del standby no significa nada"
        : "V3 NO PASA · mirar los brazos"}
    fs.writeFileSync(process.argv[2],JSON.stringify(r,null,2)+"\n");console.log(JSON.stringify(r,null,2))
  ' "$D/muestras.jsonl" "$D/veredicto.json"
  say ""
  say "  Evidencia de log (grep de armado/desarmado en ambos nodos):"
  grep -h "lazos ARMADOS\|lazos DESARMADOS\|EN ESPERA (standby)" "$D/log-activo.txt" "$D/log-standby.txt" | tail -8
}

# ── V8 · sin colateral ─────────────────────────────────────────────────────────────────────────────
# Una promoción medida y, DESPUÉS del acto, smoke de LOS NUEVE PIs servidos por el borde con
# verificación de CONTENIDO — no «200». Cada PI tiene que traer las cuatro áreas sembradas y sus
# cifras: un 200 con la página vacía es exactamente el modo de falla «gráfico vacío, dato correcto».
# CONTROL NEGATIVO del verificador: un invariante que NO está en el dato ('Poniente') y un slug que no
# existe ('bench-99'). Si esos dos salieran verdes, el verificador no está leyendo el cuerpo.
cmd_v8() {
  D="$DATOS/v8"; mkdir -p "$D"
  medir_acto v8 promote
  act=$(activo_vivo); [ -n "$act" ] || die "V8: tras el acto no hay anillo con el plano de control."
  na=$(nombre_de "$act")
  say ""
  say "── V8 · smoke de TODOS los PIs por el BORDE, con verificación de contenido ──"
  docker exec "$na" node -e '
    const base="http://benchv14-caddy:8079", email="banco@v14.local"
    const inv=["Norte","Centro","Sur","Oriente","120","90","140","60"]
    const pedir=async(slug)=>{try{const r=await fetch(`${base}/${slug}`,{headers:{"X-Forwarded-Email":email}});const b=await r.text();return{slug,status:r.status,bytes:b.length,cuerpo:b}}catch(e){return{slug,status:null,bytes:0,cuerpo:"",error:e.name}}}
    ;(async()=>{
      const pis=[...Array(9)].map((_,i)=>"bench-"+String(i+1).padStart(2,"0"))
      const filas=[]
      for(const s of pis){const r=await pedir(s);const faltan=inv.filter(v=>!r.cuerpo.includes(v));filas.push({slug:s,status:r.status,bytes:r.bytes,invariantesFaltantes:faltan,ok:r.status===200&&faltan.length===0})}
      // CONTROL NEGATIVO 1 · un invariante que el dato NO tiene.
      const r1=await pedir("bench-01"); const cn1={caso:"invariante-ausente(Poniente)",detectado:!r1.cuerpo.includes("Poniente")}
      // CONTROL NEGATIVO 2 · un slug que no existe.
      const r2=await pedir("bench-99"); const cn2={caso:"slug-inexistente(bench-99)",status:r2.status,detectado:r2.status!==200}
      const ok=filas.filter(f=>f.ok).length
      const out={v:"V8",pisOk:ok,de:filas.length,filas,controlesNegativos:[cn1,cn2],
        veredicto: ok===filas.length && cn1.detectado && cn2.detectado
          ? "V8 PASA · 9/9 con contenido verificado, y el verificador demuestra que sabe fallar"
          : "V8 NO PASA · mirar filas y controles negativos"}
      console.log(JSON.stringify(out,null,2))
    })()' | tee "$D/smoke.json"
}

# ── V9 · takeover ante crash ───────────────────────────────────────────────────────────────────────
# `docker kill -s SIGKILL` al activo con el standby vivo. El standby tiene que ADQUIRIR con `epoch+1`
# dentro de `STALE_MS` (10 s) + un período de renovación (2 s), y armar sus lazos UNA sola vez.
# SIGKILL y no `stop`: un release ordenado deja marca de release y el sucesor no paga el stale window
# — justamente el camino que este V no mide. Acá el titular muere SIN soltar nada.
cmd_v9() {
  D="$DATOS/v9"; mkdir -p "$D"
  act=$(activo_vivo); [ -n "$act" ] || die "V9 necesita un activo vivo."
  if [ "$act" = "$V1" ]; then esp=$V2; else esp=$V1; fi
  na=$(nombre_de "$act"); ne=$(nombre_de "$esp")
  ep_antes=$(contrato_de "$ne" | sed -n 's/.*"observedEpoch":\([0-9]*\).*/\1/p' | head -1)
  armados_antes=$(docker logs "$ne" 2>&1 | grep -c "lazos ARMADOS" || true)
  say "── V9 · takeover ante crash · muere $act ($na) · sobrevive $esp ($ne) ──"
  say "  época observada por el standby ANTES: ${ep_antes:-?} · veces que armó lazos ANTES: $armados_antes"
  contrato_de "$ne" >"$D/contrato-standby-antes.txt"

  # Los anillos nacen con `--restart unless-stopped`: un SIGKILL sale con 137 y Docker LO RESUCITA en
  # menos de un segundo. Eso no es el crash que V9 mide —el titular que muere y NO vuelve— así que la
  # política se retira ANTES del kill y se restaura después. Acotado por nombre a este anillo.
  docker update --restart=no "$na" >/dev/null 2>&1 || true
  t0=$(ahora_ms)
  docker kill -s SIGKILL "$na" >/dev/null
  say "  SIGKILL enviado a $na en t0=$t0 (el comando miente: la medición es el sondeo de abajo)"

  # Sondeo del standby cada 250 ms hasta que declare `held:true`, con techo de 60 s.
  t_adq=''
  i=0
  while [ "$i" -lt 240 ]; do
    c=$(contrato_de "$ne")
    case "$c" in *'"held":true'*) t_adq=$(ahora_ms); break ;; esac
    sleep 0.25
    i=$((i + 1))
  done
  fin=$(ahora_ms)
  contrato_de "$ne" >"$D/contrato-standby-despues.txt"
  docker logs --timestamps "$ne" >"$D/log-sobreviviente.txt" 2>&1 || true
  ep_desp=$(sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' "$D/contrato-standby-despues.txt" | head -1)
  armados_desp=$(docker logs "$ne" 2>&1 | grep -c "lazos ARMADOS" || true)
  fase=$(fase_de "$ne" | head -c 120)

  if [ -n "$t_adq" ]; then ms=$((t_adq - t0)); else ms=-1; fi

  # LA CIFRA QUE VALE NO ES LA DEL SONDEO. `ahora_ms()` fabrica los milisegundos (`date +%s000`) y cada
  # vuelta del sondeo cuesta un `docker exec`: el «13 s» que sale de ahí tiene una resolución de segundos
  # y un sesgo hacia arriba. Los dos instantes exactos existen y no son míos: la MUERTE la sella Docker
  # (`State.FinishedAt`, nanosegundos) y la ADQUISICIÓN la sella el propio nodo en su log con timestamp.
  # Se re-deriva de ahí, y el sondeo queda como lo que es: el disparador, no la medición.
  muerte=$(docker inspect --format '{{.State.FinishedAt}}' "$na" 2>/dev/null || printf '')
  adq_log=$(grep "RELEVO: control adquirido" "$D/log-sobreviviente.txt" | tail -1 | awk '{print $1}')
  armado_log=$(grep "RELEVO completo" "$D/log-sobreviviente.txt" | tail -1 | awk '{print $1}')
  # shellcheck disable=SC2016  # es código JS, no expansión de shell
  node -e '
    const [muerte,adq,armado,epA,epD,arA,arD,fase,msSondeo,acto,superv]=process.argv.slice(1)
    const d=(x)=>{const t=Date.parse(x);return Number.isFinite(t)?t:null}
    const m=d(muerte), a=d(adq), r=d(armado)
    // Techo REAL del protocolo, leído del código y no supuesto: staleMs (10 s, `DEFAULT_STALE_MS`)
    // + una vuelta del poller de relevo (`serve-rls.ts`: setInterval de max(500, renewMs) = 2 s)
    // + el período de renovación que `#reclamar` espera ANTES de confirmar por relectura
    // (`control-lease.ts` §Relevo, `await this.#sleep(this.#renewMs)`) = 14 s.
    const techo=14000
    const ms = m!==null && a!==null ? a-m : null
    const out={v:"V9",muerto:acto,sobreviviente:superv,
      muerteExacta:muerte||null, adquisicionExacta:adq||null, lazosArmadosExacto:armado||null,
      msHastaAdquirir_exacto:ms, msHastaLazosArmados_exacto: m!==null&&r!==null?r-m:null,
      msHastaAdquirir_porSondeo:Number(msSondeo),
      techoDelProtocoloMs:techo, techoDesglose:"staleMs 10000 + poll de relevo 2000 + confirmación 2000",
      epocaAntes:Number(epA), epocaDespues:Number(epD), deltaEpoca:Number(epD)-Number(epA),
      armadosAntes:Number(arA), armadosDespues:Number(arD), vecesQueArmoEnEsteRelevo:Number(arD)-Number(arA),
      faseFinal:fase,
      veredicto: ms!==null && ms<=techo && Number(epD)-Number(epA)===1 && Number(arD)-Number(arA)===1
        ? "V9 PASA · adquirió con época+1 dentro del techo del protocolo y armó los lazos UNA sola vez"
        : "V9 NO PASA · mirar los brazos"}
    console.log(JSON.stringify(out,null,2))
  ' "$muerte" "$adq_log" "$armado_log" "${ep_antes:-0}" "${ep_desp:-0}" "$armados_antes" "$armados_desp" "$fase" "$ms" "$act" "$esp" >"$D/resultado.json"
  cat "$D/resultado.json"
  say ""
  say "  Tramos internos del sobreviviente:"
  grep -E "RELEVO|ARMADOS|adquir|EN ESPERA|época" "$D/log-sobreviviente.txt" | tail -8
  say ""
  say "  LECTURA: V9 pasa si msHastaAdquirir_exacto ≤ 14000 —el techo del protocolo, desglosado en el"
  say "  propio resultado y leído del código—, la época subió EXACTAMENTE en 1, y los lazos se armaron"
  say "  UNA sola vez más que antes."
  # Se devuelve el anillo muerto al mundo (como standby del nuevo titular) y se restaura su política.
  docker start "$na" >/dev/null 2>&1 || true
  docker update --restart=unless-stopped "$na" >/dev/null 2>&1 || true
}

# ── V9 · CONTROL NEGATIVO · sin kill, el standby JAMÁS adquiere ────────────────────────────────────
# Lento a propósito y NO se recorta: 10 min. Es el brazo que impide leer la adquisición de V9 como
# «el standby adquiere cada cierto rato de todos modos».
cmd_v9neg() {
  D="$DATOS/v9-negativo"; mkdir -p "$D"
  segs=${1:-600}
  act=$(activo_vivo); [ -n "$act" ] || die "el control negativo de V9 necesita un activo vivo."
  if [ "$act" = "$V1" ]; then esp=$V2; else esp=$V1; fi
  ne=$(nombre_de "$esp")
  say "── V9 · CONTROL NEGATIVO · ${segs}s SIN kill · el standby ($esp) no debe adquirir jamás ──"
  : >"$D/muestras.jsonl"
  t0=$(ahora_ms); i=0; adquirio=0
  while [ "$i" -lt "$segs" ]; do
    c=$(contrato_de "$ne")
    h=$(printf '%s' "$c" | grep -c '"held":true' || true)
    [ "$h" = 0 ] || adquirio=1
    printf '{"t":%s,"held":%s}\n' "$(ahora_ms)" "$([ "$h" = 0 ] && echo false || echo true)" >>"$D/muestras.jsonl"
    sleep 5
    i=$((i + 5))
  done
  t1=$(ahora_ms)
  n=$(wc -l <"$D/muestras.jsonl" | tr -d ' ')
  printf '{"v":"V9-negativo","segundos":%s,"muestras":%s,"adquirioAlgunaVez":%s,"inicio":%s,"fin":%s,"veredicto":"%s"}\n' \
    "$segs" "$n" "$([ "$adquirio" = 0 ] && echo false || echo true)" "$t0" "$t1" \
    "$([ "$adquirio" = 0 ] && echo 'PASA · el standby nunca adquirió sin que el titular muriera' || echo 'NO PASA · adquirió sin kill: la adquisición de V9 no prueba el takeover')" >"$D/resultado.json"
  cat "$D/resultado.json"
}

# ── V11 · gate de esquema contra un store REAL ─────────────────────────────────────────────────────
# `PRAGMA user_version=99` sobre el `governance.sqlite` que comparten los anillos, y el candidato se
# reinicia para RELEERLO (un standby abre en modo lectura: expone la versión sin aplicarse el gate).
# El pre-flight de `promote` tiene entonces que NEGARSE nombrando 99 vs el soportado, sin tocar nada.
# CONTROL NEGATIVO: con la versión correcta, el mismo `promote` PROCEDE.
#
# ⚠ El activo tiene el archivo abierto en escritura: tocarlo por fuera es justamente lo que su fencing
# delata. Por eso este V se corre en ventana propia, verifica `degraded` al terminar y restaura.
cmd_v11() {
  D="$DATOS/v11"; mkdir -p "$D"; secreto_cargar
  act=$(activo_vivo); [ -n "$act" ] || die "V11 necesita un activo vivo."
  if [ "$act" = "$V1" ]; then cand=$V2; else cand=$V1; fi
  nc=$(nombre_de "$cand"); na=$(nombre_de "$act")
  GOV="$RUN/governance/governance.sqlite"
  say "── V11 · gate de esquema · activo=$act · candidato=$cand ──"
  cp "$GOV" "$D/governance.sqlite.bak"
  ver0=$(sqlite3 "$GOV" 'PRAGMA user_version;')
  say "  user_version del archivo ANTES: $ver0 (respaldo en $D/governance.sqlite.bak)"

  # ── brazo POSITIVO: el archivo dice 99 ────────────────────────────────────────────────────────
  sqlite3 "$GOV" 'PRAGMA user_version=99;'
  say "  user_version escrito: $(sqlite3 "$GOV" 'PRAGMA user_version;') (verificado LEYENDO el archivo)"
  docker restart "$nc" >/dev/null
  # El candidato tiene que volver a estar en pie y declarar la versión que acaba de leer.
  i=0; while [ "$i" -lt 60 ]; do case "$(fase_de "$nc")" in *'"phase":'*) break ;; esac; sleep 1; i=$((i+1)); done
  contrato_de "$nc" >"$D/contrato-candidato-99.txt"
  say "  /contrato del candidato declara fileVersion: $(sed -n 's/.*"name":"gobierno"[^}]*"fileVersion":\([0-9]*\).*/\1/p' "$D/contrato-candidato-99.txt" | head -1)"
  set +e
  sh "$TOOL" promote "$cand" >"$D/promote-con-99.log" 2>&1
  rc99=$?
  set -e
  say "  promote con esquema 99 → rc=$rc99"
  sed -n '1,40p' "$D/promote-con-99.log"
  upstream99=$(edge_upstreams)

  # ── brazo NEGATIVO (control): versión correcta, el mismo promote procede ──────────────────────
  sqlite3 "$GOV" "PRAGMA user_version=$ver0;"
  say ""
  say "  CONTROL NEGATIVO · user_version restaurado a $(sqlite3 "$GOV" 'PRAGMA user_version;')"
  docker restart "$nc" >/dev/null
  i=0; while [ "$i" -lt 60 ]; do case "$(fase_de "$nc")" in *'"phase":'*) break ;; esac; sleep 1; i=$((i+1)); done
  contrato_de "$nc" >"$D/contrato-candidato-ok.txt"
  set +e
  sh "$TOOL" promote "$cand" >"$D/promote-con-version-ok.log" 2>&1
  rcok=$?
  set -e
  say "  promote con esquema correcto → rc=$rcok"
  tail -12 "$D/promote-con-version-ok.log"

  deg=$(contrato_de "$(nombre_de "$act")" | grep -c '"degraded":true' || true)
  {
    printf '{"v":"V11","versionOriginal":%s,"rcConEsquema99":%s,"rcConEsquemaCorrecto":%s,' "$ver0" "$rc99" "$rcok"
    printf '"gateNombro99":%s,"nadaSeToco_upstreamTrasElRechazo":%s,"storesDegradados":%s}\n' \
      "$(grep -c 'archivo del store está en' "$D/promote-con-99.log" || true)" \
      "$(printf '%s' "$upstream99" | sed 's/"/\\"/g;s/^/"/;s/$/"/')" "$deg"
  } >"$D/resultado.json"
  cat "$D/resultado.json"
  say ""
  say "  LECTURA: V11 pasa si rcConEsquema99 != 0 con el mensaje nombrando 99, el borde NO cambió de"
  say "  upstream, y el control negativo (versión correcta) SÍ promovió."
}

# ── V12 · la sala de espera ────────────────────────────────────────────────────────────────────────
# `docker kill` al activo SIN standby vivo, y un request POR EL CONMUTADOR mientras no hay a quién
# rutear: `lb_try_duration 90s` tiene que RETENERLO y devolver 200 al sanar. Ninguna 502/503/404.
# CONTROL NEGATIVO: `lb_try_duration 1ms` y el MISMO acto tiene que producir el error.
#
# ⚠ LA TRAMPA HISTÓRICA DE ESTE CONTROL: `sed -i` cambia el inodo del archivo y el bind-mount sigue
# viendo el anterior — el control sale VERDE-FALSO. Acá el archivo se reescribe EN SU MISMO INODO y,
# sobre todo, el valor vigente se lee del SUJETO (admin API `:2019`), jamás del archivo editado.
CFG_BENCH="" # se fija en cmd_v12
lb_vigente() {
  docker exec benchv14-caddy wget -q -O- http://127.0.0.1:2019/config/ 2>/dev/null |
    tr ',' '\n' | sed -n 's/.*"try_duration":\([0-9]*\).*/\1/p' | head -1
}
lb_fijar() {
  # Reescritura EN EL MISMO INODO (`>` sobre el archivo existente), nunca `sed -i`.
  node -e '
    const fs=require("node:fs");const [f,val]=process.argv.slice(1)
    const s=fs.readFileSync(f,"utf8").replace(/lb_try_duration\s+\S+/,"lb_try_duration "+val)
    fs.writeFileSync(f,s)  // truncate+write: conserva el inodo que el bind-mount tiene tomado
  ' "$CFG_BENCH" "$1"
  docker exec benchv14-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 ||
    die "V12: el borde rechazó la config con lb_try_duration=$1. No se sigue midiendo con una config que no cargó."
  sleep 1
  say "    verificado CONTRA EL SUJETO (admin :2019) → try_duration = $(lb_vigente) ns"
}

cmd_v12() {
  D="$DATOS/v12"; mkdir -p "$D"
  CFG_BENCH="$BENCH/Caddyfile.bench"
  cp "$CFG_BENCH" "$D/Caddyfile.bench.bak"
  act=$(activo_vivo); [ -n "$act" ] || die "V12 necesita un activo vivo."
  if [ "$act" = "$V1" ]; then otro=$V2; else otro=$V1; fi
  na=$(nombre_de "$act"); no=$(nombre_de "$otro")
  say "── V12 · sala de espera · único nodo vivo = $act ($na) ──"
  say "· se detiene el otro anillo ($no): V12 mide el hueco SIN standby, que es el que la sala cubre."
  docker stop "$no" >/dev/null 2>&1 || true
  # Mismo motivo que en V9: con `--restart unless-stopped` Docker resucita al muerto en menos de un
  # segundo y el hueco que la sala de espera tiene que cubrir no llega a existir. Se retira y se restaura.
  docker update --restart=no "$na" >/dev/null 2>&1 || true
  secreto_cargar

  # El instrumento vive en un contenedor hermano que el acto NO recrea (el mutador ya está declarado).
  $COMPOSE --profile medicion up -d --no-deps mutador >/dev/null 2>&1 || true
  sleep 2

  # ── brazo POSITIVO ────────────────────────────────────────────────────────────────────────────
  say ""
  say "  brazo POSITIVO · lb_try_duration del espejo:"
  lb_fijar 90s
  docker kill "$na" >/dev/null
  t0=$(ahora_ms)
  say "  SIGKILL a $na en t0=$t0 · disparando el request por el conmutador (timeout 60 s)…"
  # El request se dispara EN PARALELO al arranque del nodo: tiene que llegar con el hueco abierto.
  docker exec -d benchv14-mutador sh -c 'node -e "const t0=Date.now();fetch(\"http://benchv14-caddy:8079/healthz\",{signal:AbortSignal.timeout(60000)}).then(async r=>{const b=await r.text();require(\"node:fs\").writeFileSync(\"/datos/v12/positivo.json\",JSON.stringify({t0,t1:Date.now(),ms:Date.now()-t0,status:r.status,cuerpo:b.replace(/\\s+/g,\" \").slice(0,200)}))}).catch(e=>require(\"node:fs\").writeFileSync(\"/datos/v12/positivo.json\",JSON.stringify({t0,t1:Date.now(),ms:Date.now()-t0,status:null,error:e.name})))"'
  sleep 3
  docker start "$na" >/dev/null
  say "  $na re-arrancado; esperando a que el request retenido termine…"
  i=0; while [ "$i" -lt 90 ]; do [ -s "$D/positivo.json" ] && break; sleep 1; i=$((i+1)); done
  say "  POSITIVO: $(cat "$D/positivo.json" 2>/dev/null || echo 'sin archivo')"
  # El nodo tiene que volver a servir antes del control negativo, o el negativo mediría otra cosa.
  i=0; while [ "$i" -lt 120 ]; do case "$(fase_de "$na")" in *'"phase":"serving"'*) break ;; esac; sleep 1; i=$((i+1)); done
  say "  fase de $na tras rearrancar: $(fase_de "$na" | head -c 100)"

  # ── brazo NEGATIVO (control del instrumento y del mecanismo) ──────────────────────────────────
  say ""
  say "  brazo NEGATIVO · el mismo acto con la retención apagada:"
  lb_fijar 1ms
  docker kill "$na" >/dev/null
  t0n=$(ahora_ms)
  say "  SIGKILL a $na en t0=$t0n (brazo negativo) · disparando el mismo request…"
  docker exec -d benchv14-mutador sh -c 'node -e "const t0=Date.now();fetch(\"http://benchv14-caddy:8079/healthz\",{signal:AbortSignal.timeout(60000)}).then(async r=>{const b=await r.text();require(\"node:fs\").writeFileSync(\"/datos/v12/negativo.json\",JSON.stringify({t0,t1:Date.now(),ms:Date.now()-t0,status:r.status,cuerpo:b.replace(/\\s+/g,\" \").slice(0,200)}))}).catch(e=>require(\"node:fs\").writeFileSync(\"/datos/v12/negativo.json\",JSON.stringify({t0,t1:Date.now(),ms:Date.now()-t0,status:null,error:e.name})))"'
  sleep 3
  docker start "$na" >/dev/null
  i=0; while [ "$i" -lt 90 ]; do [ -s "$D/negativo.json" ] && break; sleep 1; i=$((i+1)); done
  say "  NEGATIVO: $(cat "$D/negativo.json" 2>/dev/null || echo 'sin archivo')"

  # ── restauración del espejo, verificada contra el sujeto ──────────────────────────────────────
  say ""
  say "  restaurando el espejo:"
  lb_fijar 90s
  i=0; while [ "$i" -lt 120 ]; do case "$(fase_de "$na")" in *'"phase":"serving"'*) break ;; esac; sleep 1; i=$((i+1)); done
  docker update --restart=unless-stopped "$na" >/dev/null 2>&1 || true
  docker start "$no" >/dev/null 2>&1 || true
  $COMPOSE --profile medicion stop mutador >/dev/null 2>&1 || true
  docker logs --timestamps benchv14-caddy >"$D/log-borde.txt" 2>&1 || true

  node -e '
    const fs=require("node:fs");const d=process.argv[1]
    const leer=(f)=>{try{return JSON.parse(fs.readFileSync(d+"/"+f,"utf8"))}catch{return null}}
    const p=leer("positivo.json"), n=leer("negativo.json")
    const r={v:"V12",positivo:p,negativo:n,
      veredicto: p&&p.status===200 && n && n.status!==200
        ? "V12 PASA · con retención el request se retuvo y respondió 200; sin retención el MISMO acto produjo el error (el control ve el fallo)"
        : p&&p.status===200 && n && n.status===200
        ? "V12 NO CONCLUYE · el control negativo salió VERDE: sospechar del TRANSPORTE (¿la config llegó al sujeto?) antes que del mecanismo"
        : "V12 NO PASA · mirar los brazos"}
    fs.writeFileSync(d+"/resultado.json",JSON.stringify(r,null,2)+"\n");console.log(JSON.stringify(r,null,2))
  ' "$D"
  cmd_estado
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
v2) shift; cmd_v2 "$@" ;;
v3) shift; cmd_v3 "$@" ;;
v8) shift; cmd_v8 "$@" ;;
v9) shift; cmd_v9 "$@" ;;
v9neg) shift; cmd_v9neg "$@" ;;
v11) shift; cmd_v11 "$@" ;;
v12) shift; cmd_v12 "$@" ;;
estado) shift; cmd_estado "$@" ;;
cn1) shift; cmd_cn1 "$@" ;;
cn2) shift; cmd_cn2 "$@" ;;
v14) shift; cmd_v14 "$@" ;;
carrera) shift; cmd_carrera "$@" ;;
reposo) shift; cmd_reposo "$@" ;;
limpiar) shift; cmd_limpiar "$@" ;;
todo) cmd_preparar; cmd_cn1; cmd_cn2 ;;
*) die "uso: $0 {preparar|estado|cn1 [segundos]|cn2|v14 <id> [promote|rollback]|carrera [N]|reposo <id> [segs]|v2|v3 [segs]|v8|v9|v9neg [segs]|v11|v12|limpiar|todo}" ;;
esac
