---
doc_id: 013/03
cluster: 013-cluster-botler-generico
tipo: Brief ejecutable (Fable → realizador Opus)
hito: H1 — el contrato del nodo habla en `lets`; la herramienta de anillos pasa a `botler-rollout`
version: 1.0
fecha: 2026-09-05
issue: "#290"
deriva_de: 01-diseno-rector-botler-generico-daftar-v1.0.md (§2.1 «Predicado de salud», §2.2, §3 B6, §5 fila H1, §7 «renombre deja ciego al poller»)
depende_de: H0 mergeado en main (#289)
gate: suite (incluida la de anillos con docker falso) + typecheck + build + lint:shell · banco e2e local cn1 (rojo) + cn2 (promoción medida con el predicado nuevo) · grep de `pis` vacío en el contrato
---

# Brief H1 — `pis` → `lets` en todo el contrato del nodo, y `botler-rollout`

**Para el realizador.** Se ejecuta **en frío**. Si el terreno contradice el brief, detente y repórtalo en el informe final.

## 0 · Reglas del repo que no se negocian

Idénticas a §0 del brief H0 (`02-brief-h0-registro-proto-botlets-v1.0.md`). Concretamente:

```sh
cd /Users/cesar/wworkspace/productos/vergis
git fetch origin && git log --oneline -3 origin/main      # H0 (#289) debe estar mergeado; si no, detente y repórtalo
git worktree add ../vergis-wt-h1 -b feat/botler-h1-lets-y-botler-rollout origin/main
cd ../vergis-wt-h1
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm ci --ignore-scripts
```

Sin `git stash`. Los cuatro gates. Pie de commits y PR. No mergeas, no cierras issues. Normas 6 y 7.

## 1 · Qué se construye, en una frase

El **contrato público del nodo Botler** deja de contar la salud en «PIs» (vocabulario de Mira) y la cuenta en **Lets** (vocabulario del canon): `/healthz`, `/contrato`, el predicado del borde de referencia, la herramienta de anillos —que pasa a llamarse **`botler-rollout`**, con `vergis-rollout` como alias que avisa—, el RUNBOOK, el README y el poller del banco, **todo en el mismo PR**, declarado «rompe» en el CHANGELOG con lo que exige de una instancia.

## 2 · El terreno, medido el 2026-09-05 — el inventario exacto de `pis`

Corre primero y compara con esta lista; lo que difiera se reporta:

```sh
grep -rn '\bpis\b\|servablePis\|"pis"' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=experimentos . | grep -v CHANGELOG.md | grep -v -i 'pistas\|pisar\|pisa\b\|pisada\|piso\b\|pisó\|pisen\|pise\b'
```

### 2.1 · Lo que ES contrato del nodo y CAMBIA

| Archivo | Qué dice hoy | Qué queda |
|---|---|---|
| `server/routes.ts` (`/healthz`, ~líneas 95-110) | `const pis = deps.healthSummary?.()`, cuerpo `{ ok, engine, phase, pis: { total, serving } }`; comentarios «`pis.serving=N`» | Cuerpo `{ ok, engine, phase, lets: { total, serving } }`; variable `lets`; comentarios en `lets` |
| `server/contract.ts` (`ReloadEvent.servablePis`, línea ~52) | `servablePis?: number` | `servableLets?: number` |
| `server/serve-rls.ts` (~líneas 2734, 2757, 2820) | `servablePis: discover().length` en `contract.record(...)` | `servableLets` |
| `deploy/Caddyfile.reference` (~líneas 42-61) | `health_body \`"phase":"serving"\`` **no menciona `pis`** — solo los comentarios | Comentarios en `lets`; el `health_body` no cambia (juzga por fase) |
| `deploy/compose.reference.yml` (~líneas 168-175) | comentario `pis.serving == pis.total` y healthcheck `(!b.pis||b.pis.total===b.pis.serving)` | `lets` en ambos |
| `docker-compose.yml` (raíz) | verifica si su healthcheck menciona `pis` | igual que el anterior |
| `deploy/rollout/vergis-rollout` | `PROG=vergis-rollout` (l. 52); `serving_ok()` (l. 226-238) lee `jnum total/serving` — **agnóstico del nombre del bloque** porque `jnum` busca la clave por regex en todo el cuerpo; mensajes de `smoke` (l. 537, 540) dicen `pis=` / `PIs` | **Renombrar el archivo a `deploy/rollout/botler-rollout`** (`git mv`), `PROG=botler-rollout`, mensajes y comentarios en `lets`/«Lets». `serving_ok()` no necesita cambiar de lógica; **verifícalo** contra el cuerpo nuevo y déjalo dicho en un comentario: «lee `total`/`serving` del bloque `lets`» |
| `deploy/rollout/vergis-rollout` (**alias nuevo**) | — | Archivo de ~10 líneas `#!/bin/sh` que imprime en stderr `vergis-rollout: nombre retirado; usa botler-rollout (mismo comando, mismos argumentos)` y hace `exec "$(dirname "$0")/botler-rollout" "$@"`. Ejecutable. Pasa `lint:shell` (el gate descubre por shebang) |
| `deploy/rollout/RUNBOOK.md` | predicado (l. 31), poller (l. 98-101 `pis=%s/%s`), l. 109, 137, 210, 271, 305-308; todas las invocaciones `vergis-rollout` | `lets` y `botler-rollout`. El poller inline del RUNBOOK lee `"serving"`/`"total"` por `sed` sin nombrar el bloque: **verifica** que siga midiendo contra el cuerpo nuevo y cambia el rótulo `pis=` por `lets=` |
| `deploy/rollout/README.md` | l. 29, 140; invocaciones | `lets`, `botler-rollout` |
| `deploy/rollout/ring.args.example`, `deploy/rings/active.caddy.example`, `deploy/edge/espera.html`, `CONTRIBUTING.md`, `docker-compose.yml`, `deploy/compose.reference.yml` | mencionan `vergis-rollout` | `botler-rollout` (con una nota donde corresponda: «antes `vergis-rollout`») |
| `deploy/rollout/bench/poller/poller-v14.mjs` (l. 8, 75-81, 104) | lee `j.pis`, registra `pisTotal/pisServing` | lee `j.lets`; campos `letsTotal/letsServing`. **`scripts/veredicto.mjs`** consume ese JSONL: revisa si nombra esos campos y cámbialo en el mismo acto |
| `deploy/rollout/bench/scripts/bench.sh`, `bench16.sh`, `compose.bench.yml`, `rings/active.caddy.seed`, `README.md`, `CORRIDAS.md` | `TOOL=…/vergis-rollout`; textos «PIs servidos» (l. 114-121, 135-139, 529-548) | `TOOL=…/botler-rollout`. Los textos y el JSON `pisServidos` del banco **hablan de los 9 PIs de Mira que el banco sirve** — eso sí son PIs, y se dejan. Solo cambia lo que lee el bloque del healthz |
| `tests/fixtures/anillos/fake-docker.sh` (l. 56) | `healthz_body()` emite `"pis":{"total":2,"serving":2}` | `"lets":{…}` |
| `tests/deploy-anillos.test.ts` | `TOOL = join(RAIZ, 'deploy/rollout/vergis-rollout')`; comentario l. 6 | `botler-rollout`; **test nuevo**: invocar `vergis-rollout status` produce el aviso en stderr y el mismo resultado que `botler-rollout status` |
| `tests/routes.test.ts` (l. 63-73), `tests/standby-control.test.ts` (l. 13, 84, 106-109), `tests/contract.test.ts` (l. 50-54, 259, 283, 357, 386) | aserciones con `pis`/`servablePis` | `lets`/`servableLets` |
| `docs/capacidades.md` filas `CAP-175` y `CAP-177` | `pis: { total, serving }`, `pis.serving == pis.total` | `lets`; columna «Desde» añade la versión de este cambio como «(desde <sin publicar>: `lets`)». **No** se crea CAP nueva: es la misma capacidad con otro nombre de campo |
| `docs/superficie-de-estado.md` | verifica si describe el cuerpo del healthz | si lo hace, `lets` |

### 2.2 · Lo que NO es contrato del nodo y NO cambia

- `server/engines/fabric.ts` (`pis: VerifiablePi[]`, parámetro interno de la verificación por PI de Fabric): es Mira/Fabric, no el Botler.
- `server/admin.ts` («Catálogo de PIs», tile `PIs`), `server/ui.ts`, `server/catalog.ts`, `server/notas.ts`, `packages/capabilities/src/freshness.ts` (`dependentPis`), `packages/mira/**`, `packages/miranda/**`: **vocabulario de Mira en superficies de Mira**. Se deja.
- `deploy/rollout/bench/experimentos/**` y `CORRIDAS.md` en sus **crudos históricos**: son registros de corridas pasadas; no se reescriben. (Si `CORRIDAS.md` da instrucciones vigentes con `vergis-rollout`, solo esas líneas.)
- El **prefijo de contenedor `vergis-<versión>`** y el nombre de la imagen: la imagen se llama Vergis; el diseño no pidió cambiarlo.
- El CHANGELOG histórico (secciones ya publicadas).

## 3 · El CHANGELOG: «rompe», con la letra que un operador puede buscar

En «Sin publicar», una entrada `###` citando **#290** y, **antes** de ella, el aviso en negrita al estilo de 0.21.0 (`**⚠ Esta versión EXIGE algo nuevo de la instancia.**`). Tiene que decir, con esas palabras:

1. **Qué rompe:** el bloque `pis` del `/healthz` se llama `lets`; `servablePis` del `/contrato` se llama `servableLets`. Un poller, healthcheck o predicado de borde que lea `pis` **deja de ver el conteo** y —según cómo esté escrito— declara sano a un nodo degradado o nunca declara sano a uno sano.
2. **Qué exige** (sección «Qué exige esta versión», como las anteriores): actualizar en el mismo acto (a) la herramienta de anillos a `botler-rollout` de esta versión, (b) el healthcheck del compose de la instancia si copia el de referencia, (c) cualquier poller propio. El `health_body` del Caddyfile de referencia **no cambia** (juzga por fase).
3. **Cómo se adopta sin corte:** la promoción por anillos ya es el acto que trae la herramienta nueva; el orden es herramienta primero (`git pull` del repo en la VM o copia del script), luego `install` + `promote` de la imagen nueva.
4. **Qué se midió:** el banco local (cn1 rojo, cn2 medido) con el predicado nuevo, y la suite de anillos con docker falso. **Qué no:** ninguna instancia real la ha promovido todavía.

## 4 · El gate, en orden

1. `grep` de §2 → **cero** ocurrencias de `pis`/`servablePis` en los archivos de §2.1 (pega la salida). Las de §2.2 quedan y se listan como «vocabulario de Mira, deliberado».
2. `npm run typecheck && npm test && npm run build && npm run lint:shell` verdes; conteo de tests antes/después. La suite de anillos (`tests/deploy-anillos.test.ts`) tarda decenas de segundos: es normal.
3. **Control negativo obligatorio (el que dice el diseño §7):** deja el `fake-docker.sh` emitiendo `"pis"` (el cuerpo viejo) y corre `tests/deploy-anillos.test.ts`: si nada se pone rojo, la herramienta **no está leyendo el bloque** y el predicado está degenerado a «solo fase» — repórtalo, porque entonces `serving_ok()` necesita exigir la presencia del bloque `lets`. Restaura con `git checkout HEAD -- tests/fixtures/anillos/fake-docker.sh`. *(Lectura del terreno al escribir esto: `jnum` busca `"total"`/`"serving"` en cualquier parte del cuerpo, así que un cuerpo con `pis` seguiría satisfaciendo el predicado. Si es así, la corrección correcta es que `serving_ok()` exija `"lets"` cuando haya conteos, y que la fixture vieja falle. Decídelo con la medición, no con esta nota, y deja escrito el resultado.)*
4. **Banco e2e local** (Docker; antes verifica `docker ps --filter name=benchv14` sin ajenos; al terminar `limpiar`):
   ```sh
   sh deploy/rollout/bench/scripts/bench.sh preparar
   sh deploy/rollout/bench/scripts/bench.sh cn1 20     # control negativo del INSTRUMENTO: debe salir ROJO (el poller ve el fallo)
   sh deploy/rollout/bench/scripts/bench.sh cn2        # promoción bajo medición con el predicado nuevo
   sh deploy/rollout/bench/scripts/bench.sh limpiar
   ```
   Se exige: cn1 **rojo** (si sale verde, el instrumento no mide: no sigas), cn2 con veredicto computado de `.run/datos/*-veredicto.json` (pega el resumen: fuera-de-predicado por familia). Si `preparar` falla por entorno, salida textual y gate **no cumplido**.
5. Alias: `sh deploy/rollout/vergis-rollout --help 2>err.txt; cat err.txt` muestra el aviso y la ayuda de `botler-rollout`.

## 5 · Lo que NO se hace en H1

- No se toca `discovery.ts`, el registro de protos ni nada de H0 salvo lo que el renombre exija.
- No se cambia la lógica de `promote`/`install`/`rollback` ni el gate de esquema.
- No se renombra la imagen ni el prefijo de contenedor.
- No se crean stores ni rutas.

## 6 · El informe final

Igual que §8 del brief H0: rama y PR; salida de los gates y conteo de tests; **qué hizo el control negativo del paso 3 y qué decidiste con `serving_ok()`**; resumen de cn1/cn2; el `grep` final; archivos tocados; lo que contradijo al brief; lo **sin medir**, con esas palabras.

---

*Doc 013/03 · Brief H1 · v1.0 · 5 de septiembre de 2026*

• *Generado con Wingworking*
