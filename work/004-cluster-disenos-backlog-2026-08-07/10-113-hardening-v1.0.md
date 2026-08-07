# 10 · #113 Hardening — el endurecimiento del despliegue como fase propia — v1.0

**Frente:** #113 (épica de roadmap) · pieza «Hardening — endurecimiento del despliegue como fase propia, no como parches sueltos»
**Horizonte:** largo plazo — arquitectura decidida + primer hito (sandbox Vega) ejecutable
**Cluster:** 004 · diseño detallado del backlog (2026-08-07)

---

## ¿Qué convierte los parches en fase?

Hoy Vergis tiene una colección notable de defensas — construidas una a una, cada una como respuesta a un análisis o un incidente puntual. Lo que NO tiene es: (1) un modelo de amenazas explícito contra el cual medir esa colección, (2) un inventario construido-vs-hueco derivado de ese modelo, y (3) una **postura de despliegue** verificable — un artefacto que diga «este nodo está endurecido hasta el nivel X» y que el propio nodo pueda comprobar al arrancar. Este diseño entrega los tres, y deja el primer hueco (sandbox del render Vega) como hito ejecutable en frío.

El precedente arquitectónico ya existe en el repo: `server/deployment-check.ts` verifica el contrato Producto→Infra al arranque y aborta ruidoso en modo estricto (`server/deployment-check.ts:1-13`, default `strict` en `:134-137`). El hardening como fase generaliza ese patrón: **cada defensa se declara, el nodo la verifica, y la ausencia grita en vez de degradar en silencio.**

---

## Estado actual verificado

Inventario medido contra el código el 2026-08-07. Todo lo no anclado se etiqueta conjetura.

### ¿Qué está construido?

| Área | Mecanismo | Ancla |
|---|---|---|
| Supply chain | `ignore-scripts=true` global (rige local, CI e imagen — `.npmrc` se copia a la imagen) | `.npmrc:4`, `Dockerfile:8,25` |
| Supply chain | Cooldown Renovate 14 días + presets de pin de digests + OSV alerts | `renovate.json:3-6` |
| Supply chain | Gate `npm audit --omit=dev --audit-level=high` en CI | `.github/workflows/build.yml:30` |
| Supply chain | SBOM + provenance `mode=max` en el build de imagen | `.github/workflows/build.yml:64-65` |
| Supply chain | Permisos mínimos del workflow (contents:read; packages:write solo en el job que publica) | `.github/workflows/build.yml:12-13,39-41` |
| Supply chain | Kernel (botler, policy) con **cero** dependencias externas por contrato; presupuesto de dependencias como regla | `docs/adr-001-lenguaje-y-supply-chain.md:54-59,81` |
| Imagen | Multi-stage, JS precompilado sin tsx, `npm ci --omit=dev --ignore-scripts`, `USER node` | `Dockerfile:5,18,31,37` |
| Gate | A10 defensa en profundidad: `VERGIS_GATE_SECRET` exige `x-gate-token` en cada request salvo `/healthz`, antes de cualquier handler | `server/serve-rls.ts:426-431`, `server/routes.ts:76-79` |
| Gate | El chequeo de despliegue ACUSA (warn) servir PIs sin gate secret — el supuesto D2 documentado | `server/deployment-check.ts:78-94`, `deploy/compose.reference.yml:94-104` |
| Identidad | Directorio de identidad fail-closed: email no mapeado → sin claim → deny | `server/serve-rls.ts:433-440`, `server/identity.ts:7,51` |
| Gobierno de PI | Default-deny por-PI: sin registro de gobierno → `null` → nadie abre; sin identidad → nada | `packages/capabilities/src/pi-authz.ts:31-33,46-47` |
| CSRF | Token HMAC-SHA256 por identidad (24 hex), verificación en tiempo constante | `server/ui.ts:135-140`, `server/http-util.ts:17-21` |
| Credenciales | Fail-closed por perfil de conexión: credencial que no resuelve ABORTA nombrando el campo; sin fallback silencioso entre modos | `deploy/compose.reference.yml:38-41` |
| Runtime | Timeout por capability-call (120 s default) con AbortSignal — una Capability colgada no cuelga la invocación | `packages/botler/src/botler.ts:21-25,138-158` |
| Runtime | Límite de profundidad de anidamiento de piezas | `packages/mira/src/compose.ts:198-204` |
| Runtime | Límites de cuerpo con corte de stream: `readBody` (duro), forms 256 KiB, multipart 30 MiB | `server/http-util.ts:24-31`, `server/ui.ts:142`, `server/multipart.ts:87` |
| Render | Cota de cardinalidad de charts (30 barras) + LRU de SVG (100) — techo de DoS por cardinalidad | `packages/capabilities/src/render-chart.ts:12-24` |
| PDF | Sidecar fail-closed de un interruptor; mudo, solo alcanzable por red interna, url_fetcher solo `data:` | `deploy/compose.reference.yml:73-78,106-118` |
| Topología | Compose de referencia: `expose` y JAMÁS `ports:` en el data-plane (vergis, pdf, y la nota D1 para ClickHouse) | `deploy/compose.reference.yml:94-104,116-118` |
| Topología | Compose Free: bind a loopback, `mem_limit: 1g`, `init: true`, healthcheck real (503-aware), rotación de logs | `docker-compose.yml` (servicio `vergis`) |
| Postura | Auto-chequeo del contrato de despliegue al arranque, strict default, aborta ruidoso | `server/deployment-check.ts` (todo el módulo) |

Egress actual del Producto (a dónde sale el proceso Node): `login.microsoftonline.com` + IMDS `169.254.169.254` para tokens AAD (`packages/capabilities/src/aad-token.ts:74,145`), el warehouse Fabric vía mssql/tedious (`packages/capabilities/package.json:12,14`), el sidecar PDF vía fetch interno (`server/pdf.ts:70`), SMTP saliente (`server/smtp.ts:10-11,329-352`) y webhooks http(s) de notificación (`server/notify.ts:124`). **Conjetura** (módulo no leído a fondo): el motor ClickHouse sale por HTTP al servicio ClickHouse de la red interna — consistente con la nota D1 del compose (`deploy/compose.reference.yml:100-103`), sin ancla de código propia.

### ¿Qué está hueco?

| # | Hueco | Evidencia |
|---|---|---|
| G1 | **Sandbox del render Vega** — el compile corre in-process, en el event loop del server | `packages/capabilities/src/render-chart.ts:632-639`; pendiente declarado en `TODO.md:17` |
| G2 | **Cero security headers** — ninguna respuesta lleva CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors` ni `Referrer-Policy`; solo `content-type` y `cache-control` (`server/ui.ts:158-161`; grep de esos headers sobre `server/` y `packages/capabilities/src/` = 0 hits, incluido grep puntual sobre `server/admin.ts`) | grep 2026-08-07 |
| G3 | **CSRF sin época**: el token es estático por identidad mientras viva el secreto — y el secreto es efímero por defecto (`randomSecret()` si no hay `VERGIS_CSRF_SECRET`), no compartible entre réplicas | `server/ui.ts:135-136`, `server/config.ts:52-55,264,291` |
| G4 | **Gate token comparado con `!==`** — no constant-time, a diferencia del CSRF que sí usa `constantTimeEqual` | `server/routes.ts:77` vs `server/ui.ts:139` |
| G5 | **Base image sin digest** (`FROM node:22-slim` a secas) y Renovate **inoperante**: la app de GitHub no está habilitada (acción humana pendiente), así que cooldown y pinDigests hoy no corren | `Dockerfile:5,18`, `TODO.md:27` |
| G6 | **Compose de referencia sin endurecimiento de contenedor**: sin `cap_drop`, `no-new-privileges`, `read_only`, `pids_limit`, `mem_limit` ni healthcheck (el compose Free sí tiene mem/healthcheck; la referencia — la que copian las instancias con gobierno — no) | `deploy/compose.reference.yml` completo |
| G7 | **Sin manifiesto de egress**: los destinos de salida del Producto viven implícitos en el código; ninguna instancia puede negar egress por default sin arqueología | (ausencia; lista de egress arriba) |
| G8 | **CI sin análisis de dependencias en PRs ni análisis estático de seguridad**: un solo workflow (`build.yml`); no hay dependency-review, CodeQL ni scorecard | `ls .github/workflows` = `build.yml` |
| G9 | **Sin rate limiting** en ninguna superficie (el TODO ya registra «rate limits del poll de frescura» como gate manual del 0.14.0) | `TODO.md:18` |

**Hallazgo de registro (Norma 6):** `TODO.md:16` declara «HMAC + época de 4h» hecho en `server/annotations.ts` — ese archivo **no existe** en el árbol actual y el único `createHmac` de todo `server/` + `packages/` vive en `server/ui.ts:136`, sin época (grep `-rln createHmac`, 2026-08-07). O el mecanismo se perdió en el refactor de la capa de notas, o el registro quedó rancio. Cualquiera de los dos merece corrección del TODO; la época se rediseña aquí (H4). *Franja no auditada:* `server/admin.ts` no se revisó entero (safeguard de plataforma); los greps puntuales sobre él (headers, HMAC/época) dieron 0.

---

## Modelo de amenazas del despliegue

¿De quién se defiende un nodo Vergis? El nodo sirve HTML con datos filtrados por RLS a toda una organización, autentica vía proxy SSO delantero, y ejecuta SQL parametrizado contra el warehouse del cliente. La frontera de confianza declarada es el motor de base de datos, no el proceso Node (`docs/adr-001-lenguaje-y-supply-chain.md:27`).

| ID | Actor / vector | ¿Qué puede lograr? | ¿Qué lo contiene hoy? |
|---|---|---|---|
| A1 | **Dato malicioso del warehouse** — filas hostiles (strings con markup, cardinalidades patológicas, valores diseñados contra el pipeline de render) | XSS en los reportes servidos; DoS del event loop vía compile Vega; explotación de un bug de vega/vega-lite con dato como gatillo | `escapeHtml` en el path de render; cota de 30 barras; **nada** aísla el compile Vega (G1) |
| A2 | **Dependencia comprometida** (supply chain npm) | La superficie más grave del producto: JS inyectado en los reportes de las organizaciones cliente (ADR-001 §superficie 4, `:66`); exfiltración desde el proceso (credenciales del warehouse en memoria) | ignore-scripts, cooldown (inoperante — G5), audit gate, SBOM; **nada** limita qué puede hacer el código ya comprometido en runtime (G1, G2, G7) |
| A3 | **Red interna hostil / topología rota** — un puerto del data-plane alcanzable saltándose el proxy | Inyección de `X-Forwarded-*` → claims a voluntad → bypass total de RLS (supuesto D2) | Gate secret A10 (opt-in), warn del deployment-check, disciplina `expose` del compose; comparación no constant-time (G4) |
| A4 | **Operador descuidado** — misconfig de la instancia (volumen sin montar, store efímero, gate sin secreto, sandbox apagado) | Degradación silenciosa de seguridad — la clase de falla que ya produjo un incidente real (avatar, 2026-07: `server/deployment-check.ts:8-10`) | `deployment-check` strict; pero solo cubre coherencia de config, no postura de seguridad |
| A5 | **Consumidor autenticado malicioso** (insider con SSO válido) | CSRF contra stewards/admins; abuso de endpoints de mutación; enumeración; DoS aplicativo | CSRF HMAC (sin época — G3), authz por-PI default-deny, RLS en la fuente, límites de cuerpo; sin rate limiting (G9) |
| A6 | **Autor de spec malicioso o descuidado** (semi-confiable: hoy los specs los sube el operador; con Miranda/#107 la autoría se abre) | Spec que degrada el nodo (charts patológicos, queries caras); el spec NO llega crudo a Vega — el producto compone el Vega-Lite desde el YAML con datos inline (`packages/capabilities/src/render-chart.ts:615-625`) | Validación de spec, cotas de render, timeout de capability; el compile sigue in-process (G1) |

**Priorización (racional = probabilidad × radio de daño ÷ costo de mitigar):**

1. **A2 y A1 primero.** Comparten el punto de detonación — el pipeline de render — y tienen el peor radio: lo que se sirve va a TODA la organización cliente, y el proceso tiene en memoria credenciales del warehouse. A1 es además el vector que la RLS no ve: la fila hostil llega *legítimamente* filtrada. El sandbox (G1) y los headers/CSP (G2) atacan exactamente este par, y el sandbox además le quita a A2 el premio gordo (un compromiso de vega ya no corre en el proceso con credenciales).
2. **A3 y A4 segundo.** Radio equivalente (bypass total de RLS / degradación invisible) pero mitigación BARATA: la mitad ya existe (A10, deployment-check) y falta elevarla a postura verificada (G4, G6, G7). Es el mejor ratio costo/beneficio del inventario.
3. **A5 y A6 tercero.** Radio acotado por las defensas vivas (RLS en la fuente, default-deny, límites); lo que falta (época CSRF, rate limits) reduce ventanas, no cierra brechas abiertas.

---

## Decisiones selladas

**D1 — El hardening es una fase con artefacto: la «postura de despliegue» verificada al arranque.** El instrumento es la extensión natural de `server/deployment-check.ts`: cada hito de esta fase agrega chequeos de postura (¿sandbox encendido? ¿CSRF persistente? ¿gate secret presente? ¿headers activos?) que el nodo verifica al arrancar y reporta en el banner existente (`server/deployment-check.ts:143-157`). La postura NO se publica en `/healthz` (corre sin gate y se mantiene reducido — `server/routes.ts:55`); su superficie de consulta es el banner de arranque y, a futuro, la página de Configuración del admin. *Racional:* el patrón ya demostró que convierte degradación silenciosa en falla ruidosa; reutilizarlo evita inventar un segundo sistema de reporte.

**D2 — Sandbox Vega = subproceso Node persistente bajo el permission model, con la red cortada por capas, no por el flag.** Mecanismo medido (ver «Experimento», abajo): `--permission` niega filesystem fuera de la allowlist pero **NO cubre red** — un `fetch` desde el proceso restringido conecta igual. Por tanto «sin red ni filesystem» se compone en tres capas: (a) **filesystem**: `--permission --allow-fs-read=<appRoot>/` (solo lectura del árbol de la app, necesario para importar vega; medido suficiente); (b) **red-aplicación**: el worker no recibe NINGUNA credencial ni env (`env: {}` en el spawn) y el spec llega con datos inline — no hay URL que resolver; en el destranque se verifica además que la `vega.View` no reciba loader capaz de resolver URLs; (c) **red-instancia**: el egress del contenedor se niega por default y se abre solo al manifiesto (H3) — la capa que sí corta TCP. *Alternativa descartada:* `worker_threads` (no aísla filesystem ni sobrevive un hard-loop sin matar el proceso entero) y namespaces/`unshare` (exige capacidades que el default de Docker niega; se vuelve dependencia de la instancia, no del Producto).

**D3 — El fallback del sandbox es fail-visible, jamás fail-open.** Si el sandbox muere, se satura o vence el timeout, el chart se reemplaza por un placeholder de error con el código de la falla — **nunca** se rinde in-process como plan B automático (anularía la defensa exactamente cuando más se necesita). Existe `VERGIS_CHART_SANDBOX=off` como apagado EXPLÍCITO (dev/diagnóstico); en producción, sandbox apagado = warn de postura (D1). Coherente con la doctrina viva «un botón muerto es imposible / fail-closed de un interruptor» (`deploy/compose.reference.yml:75-78`).

**D4 — La frontera Producto/instancia se respeta y se instrumenta.** El Producto owns lo que corre dentro de la imagen y el CONTRATO declarativo (compose de referencia + deployment-check); la instancia owns topología, egress, recursos y secretos (`deploy/compose.reference.yml:7-10`; runbook en la skill `mira-ops`). El hardening NO mueve esa frontera: donde el Producto no puede imponer (egress, cap_drop), **declara** — manifiesto de egress + compose de referencia endurecido — y el deployment-check verifica lo verificable desde adentro.

**D5 — CSRF gana época y el secreto gana persistencia exigida.** Token = `HMAC(secret, "vergis-csrf|" + email + "|" + epoch)` con época de 4 h y ventana de gracia de 1 época hacia atrás (un form abierto 3h59 no muere al enviarse). Postura: `csrfSecret.ephemeral === true` (`server/config.ts:291`) pasa a warn de postura en despliegues con superficies de gestión. *Racional:* hoy el token de una identidad es constante hasta el próximo restart — robado una vez, vale indefinidamente (G3); la época acota la ventana al costo de un HMAC.

**D6 — El gate token se compara en tiempo constante.** `server/routes.ts:77` pasa de `!==` a `constantTimeEqual` (ya existe en `server/http-util.ts:17-21`). Cambio de una línea, cierra G4.

**D7 — Headers de seguridad en dos pasos: primero los gratis, después CSP con nonce.** Paso 1 (sin riesgo de romper nada): `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` (+ `frame-ancestors 'none'` cuando llegue la CSP), emitidos centralizadamente. Paso 2 (requiere censo): CSP con nonce por respuesta. El producto emite JS inline por diseño — table-runtime embebido vía `.toString()` (`docs/adr-001-lenguaje-y-supply-chain.md:24`), handlers `onclick`/`onsubmit` (`server/ui.ts:125,128`; `server/admin-cargas.ts:254`) — y los handlers de atributo NO se salvan con nonce: exigen refactor a `addEventListener` o `'unsafe-hashes'`. Ese censo envejece rápido; se hace al destrancar H2, no aquí.

**D8 — `[propuesta — revocable por César]` Supply chain operacional: pin por digest + Renovate habilitado + dependency-review.** (a) Pin del `FROM node:22-slim` por digest en ambos stages — hoy inerte porque Renovate (quien lo mantendría) no está instalado; la propuesta incluye reiterar la habilitación de la app (acción humana, ya en `TODO.md:27`). (b) Action `dependency-review` en PRs (gratis, sin infra). (c) CodeQL/Scorecard quedan explícitamente FUERA de la recomendación inicial: ruido/costo sin driver — *alternativa descartada, reversible si el open-core (frente 11) lo vuelve señal pública de higiene.*

**D9 — Rate limiting se hereda como pieza de la fase, no se diseña aquí.** Ya existe como gate manual del 0.14.0 (`TODO.md:18`, poll de frescura). El diseño de un rate limit genérico por identidad entra en H4 como arquitectura (token bucket en memoria por nodo, sin estado compartido); su detalle fino se sella cuando el primer consumidor real (frescura) lo mida. Fingir precisión hoy sería inventar números.

---

## Arquitectura y contratos — Hito 1: sandbox Vega

### Módulos

```
packages/capabilities/src/chart-sandbox/
  worker.mjs        ← entrypoint del subproceso (SIN dependencias fuera de vega/vega-lite)
  pool.ts           ← cliente del padre: spawn, cola, timeouts, respawn, códigos de error
  protocol.ts       ← shapes del protocolo NDJSON (tipos compartidos padre/worker)
packages/capabilities/src/render-chart.ts   ← vegaLiteToSvg se vuelve inyectable
server/serve-rls.ts                          ← wiring: crea el pool en boot, warm-up, config
```

### Contrato del subproceso

**Spawn (en `pool.ts`):**

```ts
spawn(process.execPath, [
  '--permission',
  `--allow-fs-read=${appRoot}/`,      // appRoot = raíz de la app (/app en la imagen): dist + node_modules, SOLO lectura
  '--max-old-space-size=256',
  workerPath,                          // dist del worker.mjs
], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
```

- `env: {}` es parte del MECANISMO, no higiene: (1) el worker no hereda `VERGIS_CONNECTIONS` ni ningún secreto — un compromiso de vega dentro del worker no encuentra nada que exfiltrar; (2) medido: un `NODE_OPTIONS` heredado con `--require` de una ruta fuera de la allowlist ABORTA el arranque bajo `--permission` (ocurrió en el experimento con el `NODE_OPTIONS` del harness local).
- Sin `--allow-fs-write`, sin `--allow-child-process`, sin `--allow-worker`.

**Protocolo NDJSON sobre stdin/stdout** (stderr = log crudo del worker, se reenvía al log del padre con prefijo):

```
worker → padre  {"ready":true}                                  // una vez, tras importar vega (~300 ms)
padre  → worker {"id":"r1","kind":"chart","spec":<TopLevelSpec>} // spec Vega-Lite YA compuesto, datos inline
worker → padre  {"id":"r1","ok":true,"svg":"<svg…>"}
worker → padre  {"id":"r1","ok":false,"code":"render-error","message":"…"}   // el compile/parse/runAsync lanzó
padre  → worker {"id":"p1","kind":"ping"}                        // liveness bajo demanda
worker → padre  {"id":"p1","ok":true,"pong":true}
```

Línea sin `id` o mal formada → el worker la loguea a stderr y la ignora (nunca responde sin correlación). El worker procesa en serie (un render a la vez): la serialización ES el aislamiento de un spec patológico — no puede envenenar renders concurrentes porque no los hay.

**Responsabilidades del padre (`pool.ts`) — el worker es no-confiable por definición:**

| Falla | Detección | Respuesta | Código |
|---|---|---|---|
| Render que no vuelve (hard-loop en expresión Vega) | Timer del PADRE por request — `VERGIS_CHART_SANDBOX_TIMEOUT_MS`, default 5 000 (holgura ×160 sobre los 31 ms medidos del primer render) | `SIGKILL` + respawn; el request recibe placeholder | `sandbox-timeout` |
| Worker muerto (crash, OOM del `--max-old-space-size`) | `exit`/`error` del child | Los in-flight reciben placeholder; respawn con backoff (1 s, 2 s, 4 s… tope 30 s) | `sandbox-crashed` |
| Cola llena | Cola FIFO acotada, default 64 pendientes | Rechazo inmediato con placeholder (no se encola indefinido) | `sandbox-saturated` |
| Spec inválido para vega | Respuesta `ok:false` del worker | Placeholder con el mensaje | `render-error` |

La distinción `render-error` (medí y salió negativo) vs `sandbox-timeout`/`sandbox-crashed`/`sandbox-saturated` (no pude medir) es deliberada — el instrumento sabe reportar su propio fallo (Ley de Wingworking, Norma 7, corolario de instrumentos).

**Contrato con el render (`render-chart.ts`):** `vegaLiteToSvg` deja de ser una función fija y pasa a ser un `SvgRenderer = (spec: TopLevelSpec) => Promise<string>` inyectado. El LRU (`CHART_SVG_CACHE`, `render-chart.ts:23-24`) queda en el PADRE — un hit de caché no toca el sandbox; solo los misses pagan el viaje. Con `VERGIS_CHART_SANDBOX=off` se inyecta la implementación in-process actual (`render-chart.ts:632-639`), que NO se borra: es el modo dev y el árbitro del benchmark.

**Ciclo de vida:** el pool (tamaño 1; sin knob de tamaño hasta que una medición lo pida) se crea en el boot del server, hace warm-up (espera `ready` + un render canario) para no pagar los ~350 ms de spawn+import en el primer request real, y NO bloquea el arranque si falla: el serving sigue con charts en placeholder y la falla gritada en el log + postura (mismo criterio que la capa de notas: `server/serve-rls.ts:446-448` — aquí «un chart no vale una caída», pero sí vale un warn permanente).

**Presupuesto de latencia (base medida):** spawn+import ≈ 350 ms (solo boot/respawn) · render caliente 5,3 ms promedio / 31 ms primero (spec de 30 barras). Presupuesto del hito: **overhead p50 del sandbox vs in-process ≤ 10 ms por miss de caché** (el costo nuevo es serialización NDJSON + IPC; los specs viajan chicos — 30 barras ≈ pocos KiB). Se verifica con benchmark en el gate del hito.

### Postura (D1) que agrega este hito

`deployment-check` gana un finding: producción sirviendo specs con `VERGIS_CHART_SANDBOX=off` (o pool que nunca llegó a `ready`) → **warn** nombrando el env. No error: el operador puede decidir correr sin sandbox, pero no sin enterarse.

---

## Plan de construcción

### H1 — Sandbox Vega *(ejecutable en frío por un Opus)*

**Territorio:** `packages/capabilities/src/chart-sandbox/{worker.mjs,pool.ts,protocol.ts}` (nuevos), `packages/capabilities/src/render-chart.ts` (inyección del renderer), `packages/capabilities/src/index.ts` (exports), `server/serve-rls.ts` + `server/config.ts` (wiring + envs `VERGIS_CHART_SANDBOX`, `VERGIS_CHART_SANDBOX_TIMEOUT_MS`), `server/deployment-check.ts` (finding de postura), `tests/chart-sandbox*.test.ts` (nuevos), `deploy/compose.reference.yml` (documentar los envs). El build debe emitir `worker.mjs` a `dist/` como entrypoint autónomo (verificar cómo empaqueta `npm run build` los `.mjs` de paquetes — el Dockerfile solo copia `dist/`, `Dockerfile:33`).

**Pasos:** (1) protocolo + worker; (2) pool con los cuatro modos de falla; (3) inyección en render-chart preservando LRU y firma de `renderDistribution`/`renderSeries` (`render-html-piece.ts:8,415,417`); (4) wiring + warm-up no-bloqueante; (5) postura; (6) tests adversariales + benchmark.

**Hecho cuando (verificable por comando):**
- `npm run typecheck && npm test && npm run build` verdes con las suites nuevas.
- Tests adversariales pasan: (a) spec con señal de hard-loop (mock del worker que no responde) → placeholder `sandbox-timeout` y el worker viejo MUERTO (assert sobre el pid); (b) `SIGKILL` al worker a mitad de un render → placeholder `sandbox-crashed` + respawn + el siguiente render sale bien; (c) 65 renders encolados con worker pausado → el 65.º recibe `sandbox-saturated` sin esperar; (d) assert de que el env del worker está VACÍO (el worker se responde a sí mismo `Object.keys(process.env)` vía un mensaje de test) y de que `readFileSync('/etc/hosts')` dentro del worker lanza `ERR_ACCESS_DENIED`.
- Benchmark (script en `tests/` o `scripts/`): p50 sandbox − p50 in-process ≤ 10 ms sobre ≥ 200 renders del mismo spec con caché apagado.
- `docker build .` verde y un smoke del contenedor rinde un PI con charts (verifica que `--permission` + ruta `/app` funcionan DENTRO de la imagen, no solo en macOS dev).

**Juez:** gates estándar del repo (typecheck, test, build) + los comandos de arriba en el cuerpo del PR.

### H2 — Headers de seguridad (paso 1 ya; CSP con nonce al destrancar)

Paso 1 ejecutable de inmediato tras H1: emisión centralizada de `nosniff`/`Referrer-Policy`/`X-Frame-Options` en `send()`/`fail()` (`server/ui.ts:158`, `server/http-util.ts`) + test de que TODA respuesta HTML los lleva. Paso 2 (CSP nonce) exige el censo de inline JS (D7) — diferido.

### H3 — Egress y contorno del contenedor (Producto declara, instancia aplica)

(1) `docs/egress.md`: manifiesto de destinos por capability (la lista verificada de este diseño como semilla), mantenido como contrato — toda dependencia nueva con red es una decisión documentada (extiende la regla de ADR-001 §D4). (2) `deploy/compose.reference.yml` endurecido: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true` + `tmpfs: /tmp` (compatible con `VERGIS_OUT=/tmp/vergis` default, `Dockerfile:22`; el governance persistente ya monta volumen propio), `pids_limit`, `mem_limit`, healthcheck e `init` (paridad con lo que el compose Free ya hace), y redes internas separadas (data-plane sin salida; egress solo desde la red que lo necesita). (3) Postura: los chequeos que se puedan hacer desde adentro (p. ej. ¿rootfs read-only? ¿corriendo como no-root?) se agregan como warns informativos.

### H4 — Secretos y sesión

Época CSRF (D5) + persistencia exigida del secreto (warn de postura) + gate constant-time (D6 — puede adelantarse a cualquier hito: es una línea) + corrección del registro rancio de `TODO.md:16` + soporte `*_FILE` para `VERGIS_GATE_SECRET`/`VERGIS_CSRF_SECRET` (paridad con el camino de archivo de `VERGIS_CONNECTIONS`, `deploy/compose.reference.yml:22-25`) + arquitectura del rate limit por identidad (D9).

### H5 — Supply chain operacional

Digest pin de la base image + habilitación de Renovate (humano — `TODO.md:27`) + `dependency-review` en PRs (D8). Sin CodeQL/Scorecard salvo revocación de D8.

---

## Destranque

| Hito | ¿Qué lo habilita? | ¿Qué re-verificar al destrabar (envejece)? |
|---|---|---|
| H1 | Nada técnico: ejecutable hoy. Solo la priorización de César (mandato del cluster: nada se implementa en esta sesión) | `render-chart.ts:632-639` (los frentes de charts #80/#81 lo tocan seguido); versión de vega (`^6.2.0`, `packages/capabilities/package.json:15`) — re-correr el experimento de permisos si hubo major; cómo emite `npm run build` los `.mjs` |
| H2·paso 1 | H1 aterrizado (comparte territorio en `ui.ts`/`http-util.ts`) | Ninguna pieza frágil |
| H2·CSP | Censo de inline JS hecho en el momento (NO usar un censo viejo: cada feature nueva agrega inline handlers) | El censo entero |
| H3 | Coordinación con el repo de infraestructura de la instancia (skill `mira-ops`); ensayo en QA antes de PROD (Ley WW, Norma 5) | Que `read_only`+`tmpfs` no rompa nada que escriba fuera de `VERGIS_OUT` (medirlo en QA, no asumirlo); el manifiesto de egress contra el código del momento |
| H4 | H1/H2 no lo bloquean; la época CSRF conviene tras resolver el hallazgo del TODO rancio (¿hubo un mecanismo que se perdió?) | `server/ui.ts` y el estado real de la capa de notas |
| H5 | **Acción humana**: instalar la app de Renovate (admin GitHub de Gegolabs) | El digest a pinear (el del día, no el de este diseño) |

---

## ¿Qué es del Producto y qué es de la instancia?

| Pieza | Producto | Instancia |
|---|---|---|
| Sandbox Vega (proceso, permisos fs, env limpio, timeouts) | ✔ (H1) | — |
| Headers / CSP | ✔ (H2) | — |
| Postura verificada al arranque | ✔ (D1) | lee el banner; decide sobre los warns |
| Manifiesto de egress | ✔ declara (H3) | ✔ aplica (firewall / redes compose) |
| `cap_drop`, `read_only`, `pids`, `mem` | declara en el compose de referencia | ✔ aplica en su compose real |
| Topología (proxy único ingress, expose-no-ports) | declara (D2/D1 en el compose) | ✔ ejecuta y custodia |
| Secretos (valores, rotación, montaje) | soporta archivo + exige no-efímero (postura) | ✔ posee los valores |
| Renovate / digests / CI | ✔ (repo del Producto) | — |

---

## Experimento del mecanismo (Norma 7)

Corridas del 2026-08-07, Node v22.22.3 local (macOS), scripts preservados en el scratchpad de la sesión (`exp-sandbox.mjs`, `exp-latencia.mjs`). La corrida que habría refutado el mecanismo del H1:

```
node --permission --allow-fs-read='<repo>/' <script>   (env sin NODE_OPTIONS)
→ { "fsRead": "DENEGADO: ERR_ACCESS_DENIED",
    "net":    "TypeError: fetch failed / cause: ECONNREFUSED",   ← conectó: la RED está ABIERTA bajo --permission
    "vega":   "SVG OK (6153 bytes)" }
→ { "tImportMs": 281, "firstRenderMs": 31, "warmAvgMs": 5.3 }    (spec de 30 barras)
```

Refutaciones posibles y qué salió: si el permission model cubriera red, el `fetch` habría dado `ERR_ACCESS_DENIED` (dio `ECONNREFUSED` → D2 capa c es NECESARIA); si vega necesitara escritura o red para rendir, el SVG habría fallado (salió). Hallazgo adicional medido: con el `NODE_OPTIONS` heredado del entorno (`--require` fuera de la allowlist) el proceso ABORTA al arrancar → `env: {}` es carga del contrato. **Pendiente de medir en el destranque (etiquetado, no afirmado):** el mismo experimento DENTRO de la imagen `node:22-slim` en Linux, y el env vacío contra todo el árbol de imports del worker.

---

## Riesgos y no-metas

**Riesgos.** (1) `--permission` sigue siendo una feature en evolución de Node — un upgrade de la base image puede cambiar flags o semántica; el smoke del contenedor en el gate de H1 lo detecta. (2) El overhead de IPC con specs de series largas podría exceder el presupuesto — el benchmark lo mide antes de aterrizar, y el presupuesto es revisable con dato, no con fe. (3) `read_only` rootfs (H3) puede romper escrituras no inventariadas — por eso pasa por QA de instancia, no directo. (4) La franja `server/admin.ts` quedó fuera de la auditoría de inventario (safeguard); sus superficies POST están cubiertas por los greps puntuales de CSRF pero no revisadas línea a línea.

**No-metas.** No hay WAF ni rate limiting distribuido (un nodo, memoria local basta — D9). No hay mTLS interno entre servicios del compose (la red interna + gate secret es la frontera declarada). No hay seccomp/AppArmor custom (default de Docker; imponerlo es de la instancia). No se reabre el debate de lenguaje (ADR-001 lo sella; el port Go del kernel tiene su propio trigger en `TODO.md:23`). No se sandboxean los OTROS renders (markdown, tablas): son transformación de texto propia sin motor de terceros — si un análisis futuro muestra lo contrario, es un frente nuevo, no una omisión de este.

---
• 🤖 Claude (Fable) · diseño del frente #113-hardening · cluster 004
