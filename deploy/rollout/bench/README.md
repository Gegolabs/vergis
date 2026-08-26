# Banco V-14 — el arnés que mide una promoción de anillos

> **Qué es.** Un mundo Docker **local y desechable** donde una promoción de anillos ocurre de verdad —dos nodos Vergis, el borde que conmuta, la sala de espera, el lease— y donde un instrumento hermano registra **cada respuesta** que un cliente habría recibido durante el acto. Es el banco que el contrato `lab/work/225` §7 llama **V-14**.
>
> **Nada de esto toca la VM, `/opt/mira` ni ninguna instancia.** Todo recurso lleva prefijo `benchv14-`, y ningún comando destructivo del banco alcanza algo que no sea suyo.

## ¿Por qué existe?

Porque «leí el código y la explicación calza» **no es medir** (Norma 7). Una promoción o deja respuestas fuera del predicado o no las deja, y eso solo lo dice un cliente que estaba pidiendo mientras el acto ocurría. El banco fabrica ese cliente y le guarda cada par (t-envío, t-respuesta).

## ¿Cómo se corre?

```sh
sh scripts/bench.sh preparar     # construye la imagen del worktree, levanta el mundo, deja 2 anillos
sh scripts/bench.sh cn1 20       # CONTROL NEGATIVO DEL INSTRUMENTO (20 s)
sh scripts/bench.sh cn2          # CONTROL NEGATIVO DEL MECANISMO (una promoción bajo medición)
sh scripts/bench.sh estado       # qué hay vivo y a quién apunta el borde, leído del SUJETO
sh scripts/bench.sh limpiar      # baja y borra lo `benchv14-`, y nada más
```

**El resto del arnés de aceptación** (V2–V13 de `lab/work/209` §3 y `lab/work/210` §10) vive en los
mismos comandos, y **cada uno trae su control negativo adentro**: no hay forma de correr el brazo
positivo sin el que demuestra que el instrumento ve el fallo.

```sh
sh scripts/bench.sh v2           # V2  lease exclusivo: activo 200 · standby 409 (+ CN: la LECTURA sí responde)
sh scripts/bench.sh v3 330       # V3  el standby no controla: ticks de lazo, ≥5 min de observación
sh scripts/bench.sh v8           # V8  sin colateral: promoción + smoke 9/9 con CONTENIDO verificado
sh scripts/bench.sh v9           # V9  takeover ante crash (SIGKILL al activo con standby vivo)
sh scripts/bench.sh v9neg 600    # V9  CONTROL NEGATIVO: 10 min sin kill — lento a propósito, no se recorta
sh scripts/bench.sh v11          # V11 gate de esquema contra el store REAL (+ CN: versión correcta procede)
sh scripts/bench.sh v12          # V12 sala de espera (+ CN: `lb_try_duration 1ms` produce el error)
npx tsx experimentos/v10-fencing.ts   # V10 el fencing delata al doble escritor (nativo, sin docker)
```

**V4, V7 y V13 no tienen comando propio**: son propiedades del acto, y las mide `v14`/`carrera` con su
poller y su loop de mutaciones. `v4-conf` en `CORRIDAS.md` es una corrida de confirmación de `v14`.
**V5 y V6 son de producción y están gated**; el banco no los corre.

> ⚠ **No se edita `bench.sh` mientras `bench.sh` corre.** `sh` lee el script por desplazamiento de
> bytes: una edición en vuelo mueve el offset y el shell retoma en medio del archivo. Ya pasó una vez
> (26-ago, a mitad de V3) y terminó ejecutando `limpiar` y muriendo con un error de sintaxis.

Todo es **idempotente y re-corrible**: `preparar` no recrea lo que ya está, y cada `cn2` promueve al anillo que hoy **no** tiene el control — corriéndolo dos veces se mide la ida y la vuelta.

Los datos crudos quedan en `.run/datos/` (gitignored): `*-poller.jsonl` (una línea por request), `*-mutaciones.jsonl`, `*-ventana.json` (los dos sellos del acto), `cn2-log-{viejo,candidato,borde}.txt` (tramos internos con timestamp) y `*-veredicto.json` (lo computado del crudo).

## ¿Qué mide, exactamente?

| Pieza | Qué es | Dónde |
|--|--|--|
| **El instrumento** | Poller que **despacha** cada ~28 ms sin esperar la respuesta anterior, timeout 20 s por request, predicado `200 ∧ phase=serving ∧ pis.serving=pis.total`, `SINMEDIR ≠ MAL` | `poller/poller-v14.mjs` |
| **El loop de mutaciones** | 1/s contra el conmutador. `POST /<pi>/imprimir`: inocua, verificable por id, y pasa por el mismo gate de control que toda escritura gobernada | `poller/mutador.mjs` |
| **El cero-pérdidas** | Re-pregunta por cada id ya cerrado el acto: un 200 no prueba que el efecto sobreviviera al handover | `poller/verificar-impresiones.mjs` |
| **El veredicto** | Se computa del JSONL, nunca de la consola. Separa las familias de lo fuera-de-predicado en vez de fundirlas en un número | `scripts/veredicto.mjs` |
| **El mundo** | ClickHouse (la fuente), el borde derivado del `Caddyfile.reference`, y el poller y el mutador como **hermanos** que el acto no recrea | `compose.bench.yml`, `Caddyfile.bench` |
| **Los anillos** | NO los declara el compose: los crea `vergis-rollout install` como `vergis-9-9-1` y `vergis-9-9-2` — que es la propiedad que permite promover sin recrear nada | `rings/ring.args.tmpl` |

**Bloque de gobierno.** Los anillos llevan `VERGIS_ADMIN_SEED` (`rings/ring.args.tmpl`). Sin él la
instancia no abre `governance.sqlite`, `/contrato` responde **403** y el **gate de esquema del
`promote` aborta el pre-flight** — que es por lo que el banco corría con `--no-schema-gate` y por lo
que V11 no se podía medir. Con el seed hay store real (`schemaSupported 1`), el gate se ejerce, y las
mutaciones gobernadas del mutador tienen store donde caer.

**Nueve PIs** (`specs/pi-01..09.yaml`, rutas `/bench-01`…`/bench-09`), sintéticos y todos sobre el mismo dataset sembrado: lo que el banco necesita de la instancia es carga de arranque y de serving representativa, no variedad de piezas. `preparar` verifica los nueve y deja el conteo en `.run/datos/pis-servidos.json`.

## Las tres reglas que el banco no negocia

1. **El instrumento vive en un contenedor que el acto NO recrea.** Uno efímero muere durante el acto y solo acota por abajo, sin decir que no pudo medir.
2. **El predicado no se relaja.** Ni en el nodo, ni en el borde, ni en el poller. Un `standby` responde 200 con `ok:true` por diseño: juzgar por código HTTP declara sano a un nodo que no sirve.
3. **La configuración se lee del SUJETO VIVO**, jamás del archivo que se editó — admin API del borde en `:2019`, `/healthz` del nodo. Una edición in-place cambia el inodo y un bind-mount puede seguir viendo lo anterior: por eso un control negativo **verde-inesperado** manda a sospechar del transporte antes que del mecanismo (`ww:wingcoding`, Regla 3).

## ¿Qué NO hace este banco?

- **No decide si un orden de operaciones es mejor que otro.** Mide el que le pongan delante. La comparación entre órdenes es del documento de diseño, y solo después de que el orden nuevo exista e igual haya pasado por acá.
- **No declara la causa de lo que observa.** El banco produce la correlación con sus timestamps; discriminar causas es de un experimento con brazos y control negativo propio (V-15 del contrato).
- **No mide por la duración del comando.** `promote` devuelve rc=0 sin que eso diga nada de lo que un cliente recibió.

## Espejo

`Caddyfile.bench` es **espejo** de `deploy/Caddyfile.reference` (snippet `anillo_activo` + listener `:8079` + `handle_errors`), sin el tramo TLS/SSO —que está aguas arriba del conmutador y por contrato no se toca en una promoción—. `rings/ring.args.tmpl` es espejo de `deploy/rollout/ring.args.example`. **Si la referencia cambia, acá también**, o el banco pasa a medir un borde que ya no existe.

---

• *Generado con [Wingworking](https://wingworking.org)*
