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
