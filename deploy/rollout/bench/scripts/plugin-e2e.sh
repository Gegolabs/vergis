#!/bin/sh
# plugin-e2e.sh — el plugin `vergis` de punta a punta contra el BANCO local (V10 de #366).
#
# Transporte local, ningún host de producción: cada verbo del CLI `vergis-ops` corre contra el mundo
# `benchv14-` que levanta `bench.sh preparar`, y cada paso afirma su EXIT (el exit es el veredicto: el
# vocabulario 0–7 distingue «medí» de «no pude medir»).
#
#   sh deploy/rollout/bench/scripts/plugin-e2e.sh
#
# Variables:
#   VERGIS_E2E_PLUGIN  raíz del plugin a medir (default: plugins/vergis de ESTE árbol). Apuntarla a un
#                      checkout anterior es el CONTROL NEGATIVO de un arreglo: los casos que el arreglo
#                      cierra tienen que salir FAIL con el plugin viejo.
#   VERGIS_E2E_OUT     dónde quedan la declaración temporal, el estado y un log por paso (default: un
#                      mktemp nuevo, que se imprime al empezar). Nunca dentro del repo (D3: una
#                      declaración `vergis-ops.json` no vive en el repo del Producto).
#
# Casos: 1 declarar + herramienta desde la imagen + recon · 2 publicar contenido · 3 el gate window ·
# 4 el poller contra BusyBox real · 5 recarga del borde medida · 6 install + CN-1 + promote + rollback ·
# 7 N4 (variable de arranque por anillo nuevo) · 8 M1 rollback a un anillo RETENIDO (frío) ·
# 9 M2 la guardia del contenedor que aloja el poller (el borde, por omisión).
#
# Sale 0 solo si todo pasó; el resumen dice cuántos PASS/FAIL. Limpia solo lo `benchv14-` y los anillos
# que el propio arnés creó.
set -u

SCRIPTS=$(cd "$(dirname "$0")" && pwd)
BENCH=$(cd "$SCRIPTS/.." && pwd)
REPO=$(cd "$BENCH/../../.." && pwd)
PLUGIN=${VERGIS_E2E_PLUGIN:-$REPO/plugins/vergis}
SP=${VERGIS_E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/vergis-plugin-e2e.XXXXXX")}
mkdir -p "$SP"
SP=$(cd "$SP" && pwd)
case "$SP/" in "$REPO"/*) echo "VERGIS_E2E_OUT no puede vivir dentro del repo ($SP)"; exit 2 ;; esac
[ -d /opt/homebrew/opt/node@22/bin ] && PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export PATH
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "hace falta Node >= 22 en el PATH"; exit 2; }
[ -f "$PLUGIN/bin/vergis-ops.mjs" ] || { echo "no hay CLI en $PLUGIN/bin/vergis-ops.mjs"; exit 2; }

D=$SP/decl
export VERGIS_OPS_STATE_DIR="$SP/state"
vo() { node "$PLUGIN/bin/vergis-ops.mjs" "$@"; }
LOG=$SP/pasos
rm -rf "$LOG" "$VERGIS_OPS_STATE_DIR"
mkdir -p "$LOG"
PASS=0
FAIL=0
N=0

paso() { # paso <exit-esperado> <etiqueta> <comando…>
  want=$1
  label=$2
  shift 2
  N=$((N + 1))
  f="$LOG/$(printf '%02d' "$N")-$(printf '%s' "$label" | tr ' /' '__').log"
  t0=$(date +%s)
  (cd "$D" && "$@") >"$f" 2>&1
  rc=$?
  t1=$(date +%s)
  if [ "$rc" = "$want" ]; then
    PASS=$((PASS + 1))
    r=PASS
  else
    FAIL=$((FAIL + 1))
    r=FAIL
  fi
  printf '%s  %-62s exit=%s (esperado %s) %ss  → %s\n' "$r" "$label" "$rc" "$want" "$((t1 - t0))" "$(basename "$f")"
}

# chequeo <etiqueta> <comando…>: una afirmación que no es un exit del CLI (el contenido de un log, un
# estado leído del sujeto).
chequeo() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "PASS  $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL  $label"
  fi
}
en_log() { grep -q -- "$2" "$LOG"/*"$1"*.log; }
corriendo() { [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = "$2" ]; }
editar() { # editar <archivo> <sed-expr>: sin `sed -i` (GNU y BSD lo escriben distinto)
  sed "$2" "$1" >"$1.e2e" && mv "$1.e2e" "$1"
}

echo "== plugin-e2e · $(date -u +%FT%TZ) · árbol $(git -C "$REPO" rev-parse --short HEAD) · plugin $PLUGIN =="
echo "   salida: $SP"

# ── 0 · el mundo ─────────────────────────────────────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -v '^benchv14-' | grep .; then
  echo "hay contenedores ajenos corriendo: no se toca el banco"
  exit 1
fi
sh "$SCRIPTS/bench.sh" preparar >"$LOG/00-preparar.log" 2>&1 || {
  echo "preparar falló: $LOG/00-preparar.log"
  tail -20 "$LOG/00-preparar.log"
  exit 1
}
echo "banco preparado (activo 9.9.1, en espera 9.9.2)"

# ── la declaración, en un directorio temporal (D3: nunca dentro del repo del Producto) ───────────
rm -rf "$D"
mkdir -p "$D/specs"
cp "$BENCH"/specs/*.yaml "$D/specs/"
cp "$BENCH/compose.bench.yml" "$D/compose.bench.yml"
cp "$BENCH/Caddyfile.bench" "$D/Caddyfile.bench"
printf '# Norma del banco\n\nGA de juguete: lo que no corta no pide permiso; lo que corta, ventana del operador; lo destructivo, aprobación.\n' >"$D/NORMA.md"
mkdir -p "$BENCH/.run/bin"
VER=$(node -p "require('$REPO/package.json').version")
cat >"$D/vergis-ops.json" <<EOF
{
  "\$schema": "https://raw.githubusercontent.com/Gegolabs/vergis/v$VER/plugins/vergis/schema/vergis-ops.schema.json",
  "schema_version": 1,
  "installations": [
    {
      "id": "banco",
      "name": "Banco V-14 del Producto (local)",
      "transport": { "kind": "local" },
      "host": { "root": "$BENCH", "compose_project": "benchv14", "compose_file": "$BENCH/compose.bench.yml" },
      "rings": {
        "env": {
          "RINGS_DIR": "$BENCH/.run/rings",
          "RINGS_IMAGE": "benchv14/vergis",
          "RINGS_EDGE": "benchv14-caddy",
          "RINGS_EDGE_URL": "http://benchv14-caddy:8079",
          "RINGS_ADMIN_EMAIL": "banco@v14.local"
        },
        "tool": "$BENCH/.run/bin/botler-rollout"
      },
      "instrument": { "baseline_seconds": 60 },
      "probe_identities": [ { "id": "banco", "email": "banco@v14.local", "groups": [] } ],
      "mirror": {
        "root": ".",
        "families": [
          { "id": "compose", "kind": "fixed", "local": "compose.bench.yml", "remote": "compose.bench.yml" },
          { "id": "borde", "kind": "fixed", "local": "Caddyfile.bench", "remote": "Caddyfile.bench" },
          { "id": "specs", "kind": "sweep", "local": "specs", "remote": "specs" }
        ],
        "unmirrored": [
          { "path": ".run", "reason": "estado de la corrida del banco (anillos, gobierno, datos)" },
          { "path": "poller", "reason": "el instrumento propio del banco V-14, no un artefacto de la instancia" }
        ]
      },
      "services": [
        { "name": "caddy", "interrupting": true, "reload": "exec:caddy reload --config /etc/caddy/Caddyfile" }
      ],
      "governance": {
        "source": "NORMA.md",
        "stage": "ga",
        "availability": "banco local, sin usuarios",
        "window_approver": "Operador del banco",
        "approver": "Principal del banco",
        "gates": { "read": "free", "content": "operator", "version": "operator", "service": "operator", "boot": "window", "service-interrupting": "window", "destructive": "approval" },
        "pretest": "render local del spec (NORMA.md)",
        "cuts_log": "CORTES.md"
      }
    }
  ]
}
EOF
BASELINE=62 # instrument.baseline_seconds + margen: promote se niega sin línea base completa

# ── 1 · declarar, herramienta desde la imagen (D9), recon ────────────────────────────────────────
paso 0 "check" vo check
paso 0 "exec rollout tool 9.9.1 (de la imagen)" vo exec rollout tool 9.9.1 --no-pull
paso 0 "recon" vo recon
paso 0 "health" vo health
paso 0 "contract" vo contract
paso 0 "smoke --rls" vo smoke --rls
paso 0 "parity" vo parity

# ── 2 · publicar contenido: clasificado, respaldado, tomado por el nodo ─────────────────────────
editar "$D/specs/pi-09.yaml" 's/display_name: "PI 09 · Asistencia por Área"/display_name: "PI 09 · Asistencia por Área (V10)"/'
paso 0 "contract classify specs/pi-09.yaml" vo contract classify specs/pi-09.yaml
paso 2 "publish sin pretest (la instalación lo exige)" vo publish specs/pi-09.yaml
paso 0 "publish specs/pi-09.yaml" vo publish specs/pi-09.yaml --pretest "V10: el spec del banco renderiza igual salvo el título"
paso 0 "smoke tras publish" vo smoke
paso 0 "smoke pi-09 con needle del título nuevo" vo smoke bench-09 --needle "(V10)"
paso 0 "parity --family specs tras publish" vo parity --family specs
BAK=$(find "$BENCH/specs" -name 'pi-09.yaml.bak-*' | sort | tail -1)
paso 0 "rollback del publish (exec run content)" vo exec run --class content -- "cat $BAK > $BENCH/specs/pi-09.yaml"
cp "$BENCH/specs/pi-09.yaml" "$D/specs/pi-09.yaml"
paso 0 "contract wait tras el rollback" vo contract wait specs/pi-09.yaml --timeout 30
find "$BENCH/specs" -name 'pi-09.yaml.bak-*' -exec rm -f {} +
paso 0 "parity tras el rollback" vo parity

# ── 3 · un servicio que corta: el gate window ────────────────────────────────────────────────────
paso 2 "exec service caddy reload sin ventana" vo exec service caddy reload
paso 2 "…con ventana pero sin poller" vo exec service caddy reload --impact "el banco no tiene usuarios" --window "Operador del banco · e2e · «dale»"

# ── 4 · el poller, contra BusyBox real: sabe fallar ──────────────────────────────────────────────
paso 0 "poller start" vo poller start
WWW=$SP/www
rm -rf "$WWW"
mkdir -p "$WWW"
: >"$WWW/vacio.json"
printf '<html><!-- "phase":"serving" --><p>espere</p></html>' >"$WWW/espera.html"
printf '{"phase":"serving","total":9,"serving":9}' >"$WWW/sueltos.json"
printf '{"ok":true,"phase":"standby","lets":{"total":9,"serving":9}}' >"$WWW/standby.json"
printf '{"ok":true,"phase":"serving","lets":{"total":9,"serving":9}}' >"$WWW/serving.json"
printf '{"ok":true,"phase":"serving","pis":{"total":9,"serving":9}}' >"$WWW/pis.json"
printf '{"ok":false,"phase":"serving","lets":{"total":9,"serving":8}}' >"$WWW/degradado.json"
docker rm -f benchv14-pollertest >/dev/null 2>&1
docker run -d --name benchv14-pollertest --network benchv14 -v "$WWW:/srv:ro" caddy:2@sha256:14a9c00d4e833ebc2b65d36515b37bde3b73f0b323a2663aaafc88953d8c4e3f caddy file-server --root /srv --listen :80 >/dev/null
i=0
until docker exec benchv14-caddy wget -q -T 1 -O- http://benchv14-pollertest/serving.json >/dev/null 2>&1 || [ $i -gt 40 ]; do
  i=$((i + 1))
  sleep 0.25
done
{
  for f in vacio.json espera.html sueltos.json standby.json serving.json pis.json degradado.json no-existe.json; do
    printf '%-14s ' "$f"
    docker exec benchv14-caddy sh -c "sh /tmp/vergis-ops-poller.sh http://benchv14-pollertest/$f 0.25 & p=\$!; sleep 1.2; kill \$p; wait \$p 2>/dev/null" | head -1 | cut -d' ' -f3-
  done
  printf '%-14s ' "sin-host"
  docker exec benchv14-caddy sh -c "sh /tmp/vergis-ops-poller.sh http://benchv14-no-existe:9/healthz 0.25 & p=\$!; sleep 2.5; kill \$p; wait \$p 2>/dev/null" | head -1 | cut -d' ' -f3-
} >"$LOG/poller-busybox.txt" 2>&1
docker rm -f benchv14-pollertest >/dev/null 2>&1
cat "$LOG/poller-busybox.txt"
esperado() { chequeo "poller.sh · $1 → $2" grep -q "^$1 *$2" "$LOG/poller-busybox.txt"; }
esperado vacio.json 'MAL status=2xx phase=- lets=- cuerpo-no-json'
esperado espera.html 'MAL'
esperado sueltos.json 'MAL.*conteos-fuera-de-bloque'
esperado standby.json 'MAL status=2xx phase=standby lets=9/9'
esperado serving.json 'OK status=2xx phase=serving lets=9/9'
esperado pis.json 'OK status=2xx phase=serving pis=9/9'
esperado degradado.json 'MAL status=2xx phase=serving lets=8/9'
esperado no-existe.json 'MAL status=404'
esperado sin-host 'SINMEDIR'

# ── 5 · la recarga del borde con su ventana y el poller corriendo ────────────────────────────────
paso 0 "exec service caddy reload (ventana + poller)" vo exec service caddy reload --impact "el banco no tiene usuarios; la recarga del borde no debería cortar" --window "Operador del banco · e2e · «dale»"
paso 0 "poller stop (la recarga del borde)" vo poller stop

# ── 6 · install + CN-1 + promote + rollback, instrumentados ───────────────────────────────────────
docker tag benchv14/vergis:9.9.1 benchv14/vergis:9.9.3
paso 0 "exec rollout install 9.9.3" vo exec rollout install 9.9.3 --no-pull
paso 2 "promote sin poller (se niega)" vo exec rollout promote 9.9.3
paso 0 "poller start (promoción)" vo poller start
paso 0 "poller cn1 --ring 9.9.3" vo poller cn1 --ring 9.9.3 --seconds 15
paso 2 "promote sin línea base (se niega)" vo exec rollout promote 9.9.3
sleep $((BASELINE - 15))
paso 0 "exec rollout promote 9.9.3" vo exec rollout promote 9.9.3
paso 0 "poller stop (promoción)" vo poller stop
paso 0 "health tras promote" vo health
paso 0 "smoke tras promote" vo smoke
paso 0 "exec rollout status" vo exec rollout status
paso 0 "poller start (rollback)" vo poller start
paso 0 "poller cn1 --ring 9.9.1 (el previo)" vo poller cn1 --ring 9.9.1 --seconds 15
sleep $((BASELINE - 15))
paso 0 "exec rollout rollback" vo exec rollout rollback
paso 0 "poller stop (rollback)" vo poller stop
paso 0 "smoke tras rollback" vo smoke

# ── 7 · N4: una variable de ARRANQUE, sin corte — un anillo nuevo del mismo código, promovido ────
cp "$BENCH/.run/rings/ring.args" "$SP/ring.args.antes"
printf -- '-e\nVERGIS_BANCO_ARRANQUE=v10\n' >>"$BENCH/.run/rings/ring.args"
docker tag benchv14/vergis:9.9.1 benchv14/vergis:sha-bench
paso 0 "install sha-bench (ring.args con env nuevo)" vo exec rollout install sha-bench --no-pull
paso 0 "poller start (N4)" vo poller start
paso 0 "poller cn1 --ring sha-bench" vo poller cn1 --ring sha-bench --seconds 15
sleep $((BASELINE - 15))
paso 0 "exec rollout promote sha-bench" vo exec rollout promote sha-bench
paso 0 "poller stop (N4)" vo poller stop
paso 0 "contract en el anillo nuevo" vo contract
chequeo "N4 · el anillo activo tiene la env nueva (env.unknown la lista)" en_log contract_en_el_anillo_nuevo 'unknown=.*VERGIS_BANCO_ARRANQUE'
paso 0 "poller start (vuelta N4)" vo poller start
paso 0 "poller cn1 --ring 9.9.1 (vuelta N4)" vo poller cn1 --ring 9.9.1 --seconds 15
sleep $((BASELINE - 15))
paso 0 "exec rollout rollback (vuelta N4)" vo exec rollout rollback
paso 0 "poller stop (vuelta N4)" vo poller stop
cp "$SP/ring.args.antes" "$BENCH/.run/rings/ring.args"

# ── 8 · M1: rollback a un anillo RETENIDO (frío) — la maniobra de emergencia ─────────────────────
# Tras §6–§7, 9.9.2 quedó retenido: detenido en disco (los calientes son dos, activo y previo). El CN-1
# contra un contenedor detenido no tiene control posible; `poller cn1` lo arranca con el gate de la
# clase version, espera su standby y recién mide. Sin el arreglo, el CN-1 sale 7 (SINMEDIR) y el
# rollback se niega (2): la emergencia sin salida.
chequeo "M1 · precondición: vergis-9-9-2 está RETENIDO (detenido)" corriendo vergis-9-9-2 false
paso 0 "poller start (M1)" vo poller start
paso 0 "poller cn1 --ring 9.9.2 (retenido: lo arranca)" vo poller cn1 --ring 9.9.2 --seconds 15
chequeo "M1 · el CN-1 dice que lo arrancó y que declaró standby" en_log 'poller_cn1_--ring_9.9.2' 'estaba RETENIDO (detenido): lo arranqué y declaró phase=standby'
sleep $((BASELINE - 15))
paso 0 "exec rollout rollback 9.9.2 (a un retenido)" vo exec rollout rollback 9.9.2
paso 0 "poller stop (M1: 0 fuera de predicado)" vo poller stop
paso 0 "smoke tras el rollback a un retenido" vo smoke
chequeo "M1 · vergis-9-9-2 quedó ACTIVO (leído de la herramienta)" en_log 'exec_rollout_rollback_9.9.2' '9.9.2 es el anillo ACTIVO'

# ── 9 · M2: la guardia del contenedor que aloja el poller, por omisión el borde ─────────────────
# Sin `instrument.container`, el poller vive en RINGS_EDGE (benchv14-caddy = servicio «caddy»). Recrear
# ese servicio con su ventana mataba la medición: la guardia solo miraba una clave que nadie declaraba.
paso 0 "check (M2)" vo check
chequeo "M2 · check dice qué servicio aloja el instrumento" en_log 'check_(M2)' 'instrumento: vive en «benchv14-caddy» (RINGS_EDGE, por omisión) = servicio «caddy»'
paso 0 "poller start (M2)" vo poller start
paso 2 "exec service caddy recreate con ventana y el poller en el borde (se niega)" vo exec service caddy recreate --impact "el banco no tiene usuarios; recrear el borde corta todo ~8 s" --window "Operador del banco · e2e · «dale»"
chequeo "M2 · la negativa nombra el poller y el camino (instrument.container)" en_log 'exec_service_caddy_recreate' 'aloja el poller que está corriendo'
paso 0 "poller stop (M2: el poller sobrevivió)" vo poller stop

echo "== plugin-e2e: $PASS PASS · $FAIL FAIL ($N pasos + chequeos) · logs en $LOG =="

# ── limpieza: solo lo del banco y los anillos que este arnés creó ───────────────────────────────
sh "$SCRIPTS/bench.sh" limpiar >/dev/null 2>&1
docker rm -f vergis-sha-bench vergis-9-9-3 >/dev/null 2>&1
docker rmi benchv14/vergis:9.9.3 benchv14/vergis:sha-bench >/dev/null 2>&1
if git -C "$REPO" status --porcelain deploy/rollout/bench/specs | grep .; then
  echo "FAIL  el árbol del banco quedó modificado"
  FAIL=$((FAIL + 1))
else
  echo "PASS  el árbol del banco quedó limpio"
fi
[ "$FAIL" = 0 ]
