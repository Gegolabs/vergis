// service.mjs — `vergis-ops exec service <nombre> reload|recreate|prevalidate`: los servicios de la
// instalación que no son anillos (borde, proxy de identidad, sidecars), declarados en `services[]`.
//
//   prevalidate  corre el `prevalidate` declarado en un contenedor EFÍMERO de la misma imagen y con los
//                mismos montajes: valida el cambio sin tocar el servicio vivo (clase read)
//   reload       el `exec:<comando>` declarado, dentro del contenedor vivo; y después COMPARA lo que el
//                contenedor ve de cada montaje de archivo contra el host — un `sed -i` o un editor
//                cambian el inodo y el contenedor sigue viendo lo viejo, y `reload` recarga lo mismo en
//                silencio (RUNBOOK §0.5): recargar no es haber leído lo nuevo
//   recreate     `compose up -d --no-deps <servicio>`, con `compose config -q` antes
//
// La clase la da la declaración: `interrupting: true` ⇒ service-interrupting (en GA, ventana del
// operador y corte medido); `false` ⇒ service. Recrear el contenedor que ALOJA el poller corta la
// medición: se niega mientras el poller corra ahí. «Ahí» se le pregunta al HOST —el contenedor donde el
// poller registrado está corriendo contra los contenedores del servicio en el compose—, no a una clave de
// la declaración: por omisión el poller vive en el borde (`RINGS_EDGE`), y una guardia que dependiera de
// que alguien lo hubiera declarado dejaría pasar justo el caso normal.

import { EXIT, fail, out, shq } from './util.mjs'
import { runRemote } from './transport.mjs'
import { gate, evidenceLine } from './exec.mjs'
import { pollerStatus } from './poller.mjs'

export async function execService(decl, ins, args, o) {
  const [name, act] = args
  if (!name || !['reload', 'recreate', 'prevalidate'].includes(act)) fail(EXIT.NOT_RUN, 'exec service <nombre> reload|recreate|prevalidate')
  const svc = (ins.services ?? []).find((s) => s.name === name)
  if (!svc) fail(EXIT.NOT_RUN, `el servicio «${name}» no está declarado en services[] (${(ins.services ?? []).map((s) => s.name).join(' · ') || 'ninguno'}): lo que la declaración no describe no se opera`)
  if (!ins.host.compose_project || !ins.host.compose_file) fail(EXIT.NOT_RUN, 'los actos sobre servicios exigen host.compose_project y host.compose_file')
  const P = shq(ins.host.compose_project)
  const F = shq(ins.host.compose_file)
  const S = shq(name)
  let cls = act === 'prevalidate' ? 'read' : svc.interrupting ? 'service-interrupting' : 'service'
  if (act === 'recreate') {
    const st = await pollerStatus(decl, ins)
    if (st.running) {
      const h = await runRemote(decl, ins, String.raw`VO_PID=$($DOCKER inspect --format '{{.Id}}' ${shq(st.rec.container)} 2>/dev/null)
for c in $($DOCKER ps -a --filter label=com.docker.compose.project=${P} --filter label=com.docker.compose.service=${S} --format '{{.Names}}'); do
  [ -n "$VO_PID" ] && [ "$($DOCKER inspect --format '{{.Id}}' "$c" 2>/dev/null)" = "$VO_PID" ] && echo "HOSTS $c"
done
echo HOSTCHECK`)
      if (!h.lines.includes('HOSTCHECK')) fail(EXIT.MUTE, `no pude averiguar si «${name}» aloja el poller: el host no completó la consulta. Sin saberlo no se recrea.`)
      const hosts = h.lines.find((l) => l.startsWith('HOSTS '))
      if (hosts) fail(EXIT.NOT_RUN, `«${name}» aloja el poller que está corriendo (${st.rec.id} en «${hosts.slice(6)}»): recrearlo mataría la medición a mitad de serie, y la fila del corte quedaría «sin medir». Mueve primero el instrumento a un contenedor de vida larga que este acto no recree —\`instrument.container\` en la declaración, \`poller stop\` y \`poller start\` de nuevo, con su CN-1— y recién entonces recrea.`)
    }
  }
  if (act === 'reload' && svc.reload === 'none') fail(EXIT.NOT_RUN, `«${name}» no declara recarga en caliente (reload: none): el camino es recreate, con su clase y su gate`)
  if (act === 'prevalidate' && !svc.prevalidate) fail(EXIT.NOT_RUN, `«${name}» no declara prevalidate`)
  const g = await gate(decl, ins, cls, o)
  let body
  if (act === 'prevalidate') {
    body = String.raw`$DOCKER compose -p ${P} -f ${F} run --rm --no-deps -T --entrypoint sh ${S} -c ${shq(svc.prevalidate)} && echo PREVALID-OK || echo PREVALID-FAIL`
  } else if (act === 'reload') {
    body = String.raw`$DOCKER compose -p ${P} -f ${F} exec -T ${S} ${svc.reload.slice(5)} && echo RELOAD-OK || echo RELOAD-FAIL
CT=$($DOCKER compose -p ${P} -f ${F} ps -q ${S} | head -1)
$DOCKER inspect "$CT" --format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' | while IFS='|' read -r t s d; do
  [ "$t" = bind ] && [ -f "$s" ] || continue
  h=$(vo_sha "$s"); c=$($DOCKER exec "$CT" sh -c "sha256sum '$d' 2>/dev/null | cut -d' ' -f1")
  if [ "$h" = "$c" ]; then echo "SEES-OK $d"; else echo "SEES-STALE $d host=$(printf '%s' "$h" | cut -c1-16) contenedor=$(printf '%s' "$c" | cut -c1-16)"; fi
done`
  } else {
    body = String.raw`$DOCKER compose -p ${P} -f ${F} config -q || { echo CONFIG-INVALID; exit 0; }
$DOCKER compose -p ${P} -f ${F} up -d --no-deps ${S} && echo RECREATE-OK || echo RECREATE-FAIL`
  }
  out(`== vergis-ops exec service ${name} ${act} · ${ins.id} · clase ${cls} ==`)
  out(`   ${evidenceLine(g)}`)
  const r = await runRemote(decl, ins, body)
  for (const l of r.lines) out(`   | ${l}`)
  if (r.lines.some((l) => /-(FAIL|INVALID)$/.test(l))) { out('⚠ el acto falló en el host (exit 1).'); return EXIT.FINDING }
  if (r.lines.some((l) => l.startsWith('SEES-STALE'))) {
    out('⚠ HALLAZGO (exit 1): el contenedor NO ve lo que tiene el host en un montaje de archivo — el inodo cambió bajo el bind-mount y la recarga recargó lo viejo. Recrea el contenedor (con su gate), o edita dentro / con docker cp.')
    return EXIT.FINDING
  }
  if (cls !== 'read') out('   si el acto cortó: `vergis-ops poller stop` da la cuenta, y la fila va a governance.cuts_log aunque diga «sin medir».')
  out('✓ hecho (exit 0).')
  return EXIT.OK
}
