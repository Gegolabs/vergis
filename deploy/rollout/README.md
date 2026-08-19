# Anillos de Vergis — desplegar sin ventana de mantenimiento

Un **anillo** es una instalación ejecutable de una versión publicada del Producto: un contenedor
`vergis-<versión>` creado desde `ghcr.io/gegolabs/vergis:<versión>`, con los **mismos** montajes de
instancia que el nodo de siempre. Hay N anillos en disco y hasta **dos calientes**: el **activo** (tiene
el plano de control y recibe el tráfico) y el **previo** (en espera, listo para un rollback instantáneo).

**Promover no recrea nada.** Traslada el plano de control de un proceso a otro y conmuta el borde en
caliente. El serving no se interrumpe; lo que se congela por unos segundos es la **escritura**.

| Pieza | Qué es |
|--|--|
| `vergis-rollout` | La herramienta de ciclo de vida (POSIX `sh`; solo `docker` y `sed`) |
| `rings/rings.json` | El registro: qué anillos existen, con qué digest, cuál es el activo y cuál el previo |
| `rings/active.caddy` | El upstream del anillo activo — **una línea**, la reescribe la herramienta |
| `rings/ring.args` | Los envs y montajes con que se crea cada anillo (espejo del servicio `vergis` del compose) |
| `edge/espera.html` | La sala de espera del borde, para el tramo en que **no hay** proceso |

El borde está en [`../Caddyfile.reference`](../Caddyfile.reference) y el stack en
[`../compose.reference.yml`](../compose.reference.yml).

## ¿Qué predicado decide que un anillo está sano?

```
200  ∧  "phase":"serving"  ∧  pis.serving == pis.total
```

**Nunca «responde» y nunca «2xx a secas».** Un nodo en espera responde **200 con `ok:true` por
diseño**: está sano, sirve lecturas y **no** tiene el plano de control — sus mutaciones contestan 409.
Cualquier chequeo que juzgue por el código HTTP declararía sano a un nodo al que no se debe rutear
tráfico. Este predicado es el mismo en los tres lugares donde se juzga: el health check de Caddy, el
smoke de la herramienta y el poller con que se mide un corte.

## Preparar la instancia (una vez)

```sh
# Junto a tu docker-compose.yml (copia de compose.reference.yml):
cp <repo>/deploy/Caddyfile.reference        ./Caddyfile          # y reemplaza <tu-dominio>
mkdir -p rings edge
cp <repo>/deploy/rings/active.caddy.example ./rings/active.caddy
cp <repo>/deploy/edge/espera.html           ./edge/espera.html
cp <repo>/deploy/rollout/ring.args.example  ./rings/ring.args    # y ajusta rutas/red/envs
cp <repo>/deploy/rollout/vergis-rollout     /usr/local/bin/vergis-rollout && chmod +x $_

docker compose up -d           # el borde queda con :8079 y la sala de espera
```

`rings/active.caddy` viene apuntando al servicio `vergis` del compose: **una instancia recién migrada
sirve igual que antes**, y la primera `promote` la mueve a un anillo versionado sin tocar nada más.

Variables (todas opcionales salvo las dos del pre-flight):

| Env | Default | Para qué |
|--|--|--|
| `RINGS_DIR` | `./rings` | Dónde viven `rings.json`, `active.caddy` y `ring.args` |
| `RINGS_IMAGE` | `ghcr.io/gegolabs/vergis` | Repositorio de la imagen (sin tag) |
| `RINGS_RETAIN` | `3` | Anillos en disco. **`2` ≡ blue-green exacto** |
| `RINGS_EDGE` | `caddy` | Nombre del contenedor del borde (`docker exec` para validar y recargar) |
| `RINGS_EDGE_URL` | `http://caddy:8079` | El conmutador, visto desde la red interna (smoke) |
| `RINGS_ADMIN_EMAIL` | — | **Un admin de la instancia**: sin esto el pre-flight de esquema no puede leer `/contrato` y la promoción **se niega** |
| `RINGS_GATE_TOKEN_FILE` | — | Archivo con el `VERGIS_GATE_SECRET`, si la instancia exige gate |
| `RINGS_PROMOTE_TIMEOUT` | `30` | Segundos de espera a que el candidato declare `serving` |
| `RINGS_SMOKE` | `1` | Smoke por el borde después del flip |

## El ciclo

```sh
vergis-rollout install 0.20.0        # pull + create + start → queda EN ESPERA, verificado
vergis-rollout status                # el registro + la fase VIVA de cada anillo + a quién apunta el borde
vergis-rollout promote 0.20.0        # pre-flight → handover → flip → smoke → registro
vergis-rollout rollback              # vuelve al previo (flip puro, en caliente)
vergis-rollout rollback 0.18.0       # a un retenido: arranca primero (la sala de espera cubre el boot)
vergis-rollout prune --dry-run       # qué retiraría la retención vigente
vergis-rollout prune                 # lo retira
vergis-rollout retire 0.17.0 --rmi   # retira un anillo puntual (y su imagen)
```

### `install <versión> [--redigest] [--no-pull] [--no-start]`

Trae la imagen, **resuelve su digest** y crea el contenedor con la identidad del anillo (`VERGIS_RING`,
`VERGIS_RING_DIGEST`, labels `vergis.ring*`) más lo que declare `ring.args`. Después lo arranca y espera
a que responda: un anillo que no llega a responder **no queda marcado como promovible**.

- **Nunca un tag móvil.** `latest`, `main` y las series (`0.19`) se rechazan: no identifican lo que
  quedaría corriendo.
- **Guard de digest.** Si la versión ya está registrada con **otro** digest, la instalación **se
  niega**. Dos imágenes distintas con el mismo número de versión es un hecho medido en este proyecto y
  el digest es lo único que las distingue. `--redigest` instala la nueva como anillo **aparte**
  (`0.19.0-r2`) sin pisar la anterior.
- **Idempotente.** Re-instalar la misma versión con la misma imagen no recrea nada.

### `promote <versión> [--timeout N] [--no-smoke] [--no-schema-gate]`

1. **Pre-flight** — el candidato existe, corre la imagen registrada, responde, y su `/contrato` declara
   que soporta el esquema del archivo del store. **Cualquier fallo acá y no se toca nada.**
2. **Handover** — `SIGUSR2` al activo (suelta el control; **sigue sirviendo lecturas**) y se espera que
   el candidato declare `serving`. Si no llega, el control vuelve al anterior y **el tráfico jamás se
   movió**.
3. **Flip** — se reescribe `active.caddy`, se **valida** la config y se recarga Caddy en caliente. Una
   config inválida restaura la línea anterior y **no se recarga**.
4. **Smoke** — por el borde, con el predicado de arriba. Falla ⇒ vuelta atrás por el mismo camino.
5. **Registro** — el anterior queda como **previo**; el nuevo, activo.

**El costo honesto:** entre el paso 2 y el `serving` del candidato (segundos) las **escrituras**
responden 409 explícitos. Las lecturas se sirven todo el tiempo y ninguna respuesta se pierde.

**El pre-flight se niega cuando no puede medir.** Sin `RINGS_ADMIN_EMAIL` (o con un email que no es
admin) `/contrato` responde 403 y la promoción aborta: un pre-flight que se salta lo que no logra leer
no es un pre-flight. `--no-schema-gate` existe para instancias **sin** bloque de gobierno (no hay store
que verificar) y lo grita en pantalla.

### `prune [--retain N] [--dry-run] [--rmi]`

Conserva los `N` anillos más recientes por fecha de instalación. **El activo y el previo se conservan
siempre**, cuenten o no dentro de la ventana, con **cualquier** combinación de flags: `--force` no los
toca, `--retain 1` no los toca. Es la línea que este comando no cruza.

## Lo que esta herramienta no hace

- No usa `latest` ni tags móviles: un anillo se instala por versión exacta y se registra por digest.
- No retira el activo ni el previo.
- No toca `docker compose`: recrear es el corte que se está eliminando.
- No borra ni «restaura» stores en un rollback. Los datos van hacia adelante; los respaldos
  pre-migración los toca **solo un humano**.
- No mide lo que no puede medir: si una sonda no obtiene respuesta lo dice, en vez de reportar un
  negativo.

## Límites declarados

- **Un solo host, FS local.** El lease del plano de control se ordena por rename atómico y relojes del
  mismo kernel. Un volumen de red con relojes desfasados queda **fuera de contrato**.
- La sala de espera **no** cubre la muerte del propio borde (residual: `restart: unless-stopped` del
  contenedor de Caddy — y ese corte sí es corte).
- El smoke por el borde verifica el predicado de salud y el índice. **No** recorre las rutas de cada PI:
  `/healthz` publica **conteos**, no slugs, y adivinar los slugs o forjar una identidad para listarlos
  sería peor que no medirlo. El invariante que sí se exige es `pis.serving == pis.total`.
- `ring.args` es un espejo manual del servicio `vergis` del compose. Nada verifica que estén
  sincronizados.
- **El handover tiene una carrera.** El nodo que suelta el control no nombra sucesor, así que cualquier
  anillo caliente puede tomar el lease — también el previo. La herramienta lo resuelve **insistiendo**:
  si el control lo tomó otro, le pide soltarlo y sigue esperando al candidato, y lo dice en pantalla
  mientras lo hace. Converge porque quien suelta queda un rato sin aspirar. **Medido en un e2e local**;
  el arreglo durable sería un handover **dirigido** en el motor (que el release nombre al sucesor), y no
  es de esta herramienta.
- **Editar el `Caddyfile` en el host puede no llegar al contenedor.** El compose lo monta como
  **archivo**, y un editor —o un `sed -i`— que reemplaza el archivo cambia su inodo: el contenedor
  sigue viendo el contenido viejo y `caddy reload` recarga… lo mismo de antes, en silencio. **Medido en
  un e2e local** (el borde reportó 90 s de retención cuando el archivo del host decía 1 ms). Tras editar
  el Caddyfile, **verifica lo que ve el contenedor** (`docker exec <borde> grep … /etc/caddy/Caddyfile`)
  o recrea el contenedor del borde. Esto **no** afecta a `active.caddy`: vive en un montaje de
  **directorio** y la herramienta lo reescribe preservando el inodo.
- El pre-flight «no toca nada» tiene una excepción declarada: si el candidato estaba **detenido**, la
  promoción lo **arranca** para poder sondearlo. Un anillo arrancado no recibe tráfico ni control, así
  que el acto sigue siendo reversible con un `docker stop`.

---

• *Generado con Wingworking*
