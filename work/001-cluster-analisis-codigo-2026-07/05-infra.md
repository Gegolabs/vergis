# Frente 05 · Infra y supply chain

**Ámbito:** Dockerfile, docker-compose.yml, .dockerignore, .github/workflows/build.yml, package.json (raíz + paquetes), package-lock.json, .npmrc, renovate.json, tsconfig(.base).json, vitest.config.ts, bin/, scripts/, schema/.

---

## Tanda Opus 4.8 — concluida

### Severidad ALTA

**1. [ALTA] · docker/supply-chain — `.env` no está excluido del build context**
`.dockerignore` (9 líneas, falta `.env`) + `Dockerfile:7` (`COPY . .`). El flujo de `docker-compose.yml:5` instruye crear `.env` con `VERGIS_CONNECTIONS` (incluye `clientSecret` del Service Principal). Como el stage de build hace `COPY . .`, un `docker compose build` en una máquina con `.env` presente **hornea el secreto en una capa del stage intermedio** (queda en el cache local del builder; se filtraría al registro si se activa `cache-to` remoto).
*Mejora:* agregar `.env`, `*.env`, `tests/`, `docs/`, `local/`, `*.md` al `.dockerignore`. Esfuerzo **S**.

### Severidad MEDIA

**2. [MEDIA] · supply-chain — vulnerabilidad crítica (dev) que el gate de CI nunca ve**
`npm audit` → **5 vulns (3 moderate, 1 high, 1 critical)**, todas en la cadena dev `vitest@2.1.9 → vite ≤6.4.2 → esbuild ≤0.24.2` (crítica GHSA-5xrq-8626-4rwp; high GHSA-fx2h-pf6j-xcff). `npm audit --omit=dev` → **0 vulns** (runtime limpio). El gate de CI (`build.yml:25`) solo audita `--omit=dev`.
*Mejora:* subir `vitest` a 4.x + gate secundario `npm audit --audit-level=critical` sin `--omit=dev`. Esfuerzo **M**.

**3. [MEDIA] · supply-chain — GitHub Actions pinneadas por tag mutable, no por SHA**
`build.yml:19,20,35-38,44,51` — `checkout@v4`, `setup-node@v4`, `login-action@v3`, `build-push-action@v6`. El workflow tiene `packages: write` + `GITHUB_TOKEN` (blast radius del incidente tj-actions/changed-files).
*Mejora:* pinnear por SHA completo + `helpers:pinGitHubActionDigests` en renovate. Esfuerzo **S**.

**4. [MEDIA] · docker — sin `HEALTHCHECK` a pesar de que `/healthz` ya existe**
El server implementa `/healthz` con semántica 503-hasta-listo (`serve-rls.ts:533,882`) y nadie lo consume. Sin él, `restart: unless-stopped` solo reacciona a crashes, no a un proceso colgado.
*Mejora:* `HEALTHCHECK` que consulte `/healthz` (Dockerfile o compose). Esfuerzo **S**.

**5. [MEDIA] · operación — compose publica el puerto en 0.0.0.0**
`docker-compose.yml:14-15` — `ports: "8080:8080"`. En la VM el gate real es Caddy+oauth2-proxy; si este compose corre ahí, el 8080 queda alcanzable saltándose el SSO (el propio archivo admite `VERGIS_USER/PASS` vacíos = sin gate).
*Mejora:* `"127.0.0.1:8080:8080"` como default seguro. Esfuerzo **S**.

**6. [MEDIA] · docker/supply-chain — imagen base `node:22-slim` por tag mutable**
`Dockerfile:5,10`. El tag `22-slim` se re-publica; dos builds del mismo commit pueden diferir y un tag comprometido pasaría inadvertido.
*Mejora:* pinnear por digest; Renovate actualiza digests con `docker:pinDigests`. Esfuerzo **S**.

**7. [MEDIA] · ci — sin escaneo de vulnerabilidades de la imagen publicada**
`build.yml` job `image` (30-59): genera SBOM y provenance pero nadie escanea la imagen ni el SBOM. Las CVEs de la base Debian slim quedan sin vigilancia.
*Mejora:* `aquasecurity/trivy-action` (o `anchore/scan-action` sobre el SBOM) post-push con gate HIGH/CRITICAL. Esfuerzo **S-M**.

**8. [MEDIA] · config — no existe lint ni formateador en todo el repo**
`package.json:10-16` — no hay `lint` ni config de eslint/biome/prettier. Con 5 paquetes + server + scripts, typecheck no atrapa `await` flotantes, imports muertos ni estilo divergente.
*Mejora:* Biome (una dependencia, sin plugins, rápido) + script `lint` + paso en el job `test`. Esfuerzo **M**.

**9. [MEDIA] · docker — el stage de build rompe el cache de dependencias en cada cambio de código**
`Dockerfile:6-8` — `COPY . .` antes de `npm ci`; cualquier edición de un `.ts` invalida la capa de `npm ci` (el stage final sí hace el patrón correcto). En CI multi-arch sin `cache-from` duplica el costo.
*Mejora:* replicar el patrón manifests→`npm ci`→`COPY` en el stage de build; `cache-from/cache-to: type=gha`. Esfuerzo **S**.

### Severidad BAJA

**10. [BAJA] · config — strict mode incompleto — `tsconfig.base.json:8-9`** — tiene `strict`+`noImplicitOverride`, faltan `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Para un compilador de policies RLS, un `array[i]` posiblemente-undefined es riesgo real. Activar al menos `noUncheckedIndexedAccess`. **M**

**11. [BAJA] · config — vitest sin coverage — `vitest.config.ts:13-15`** — solo `include`. Sin señal de qué porción del compilador de policies está cubierta. `@vitest/coverage-v8` + umbral informativo. **S**

**12. [BAJA] · ci — permisos del token a nivel workflow — `build.yml:11-13`** — `packages: write` aplica también al job `test` (corre en PRs) que no lo necesita. Mover `permissions` a nivel de job + `concurrency`. **S**

**13. [BAJA] · operación — compose sin límites de recursos ni rotación de logs** — sin `mem_limit`/`cpus` ni `logging: max-size/max-file`. Con json-file default y un server que loguea por request, el disco de una VM pequeña muere primero. `logging` + `mem_limit` + `init: true`. **S**

**14. [BAJA] · operación — versión/CHANGELOG rezagados** — `package.json:4`=0.2.2 y CHANGELOG último=0.2.2, pero la rama acumula 4 commits de features del DSL (rondas 1-3 de work/052). El esquema declarado pide 0.3.0 — y el pie del inspector mostrará "Mira v0.2.2" para un motor que ya no lo es. Bump a 0.3.0 + entry antes del merge/tag. **S**

**15. [BAJA] · operación — secreto HMAC literal en el arnés de humo — `scripts/admin-smoke.ts:67,81`** — `secret: 'smoke-secret'` hardcodeado (arnés local, bien documentado). `process.env['VERGIS_SECRET'] ?? 'smoke-secret'`. **S**

### Verificado que está bien resuelto (no reportado)
Lockfile v3 íntegro (300 entradas, todas `sha512`, todas del registry oficial, sin overrides); `npm audit --omit=dev`=0; multi-stage sin tsx con `USER node` y `CMD` en exec-form (SIGTERM directo); `.npmrc ignore-scripts=true`; SBOM+provenance `mode=max`; Renovate con cooldown de 14 días + bypass OSV; `.env` en `.gitignore`; sin secretos en build args.

### Evaluación general (Opus)

Postura de supply-chain del runtime notablemente buena: superficie de producción de 4 dependencias directas, audit limpio, lockfile íntegro, imagen precompilada non-root sin lifecycle scripts, SBOM+provenance, cooldown de Renovate. Los huecos son de segundo anillo: los dos vectores mutables (tags de Actions y de imagen base sin pin por SHA/digest), un `.dockerignore` que deja pasar el `.env` con el secreto del SP — el hallazgo más urgente y el más barato —, y la deuda dev-side (vitest 2.x con crítica, sin lint/coverage/escaneo de imagen). El compose "Free" es honesto para laptop pero necesita tres líneas (bind a loopback, healthcheck, rotación de logs) para ser seguro por defecto en una VM. Nada estructural: ajustes S/M sobre una base sólida.

---

## Segunda corrida — Opus 4.8 (el override a Fable no surtió efecto)

> El parámetro `model: "fable"` **no fue honrado** por el harness: este segundo pase corrió otra vez en Opus 4.8 (confirmado porque el agente hermano de admin/multipart volvió a chocar con el *safeguard de ciberseguridad de Opus*). No es contraste de motor Fable vs Opus, sino una **segunda opinión independiente en el mismo motor** — útil para ver qué hallazgos son estables entre corridas y cuáles aparecen solo en una.

Ya tengo el cuadro completo. Armo el informe.

---

# Revisión senior de infra/supply-chain — Vergis (`feat/052-r3-features-dsl`, estado actual verificado)

## Resultados reales de auditoría (ejecutados hoy)

- **`npm audit --omit=dev`**: **0 vulnerabilidades** ✅ (coincide con lo que gatea el CI).
- **`npm audit` (completo)**: **5 vulnerabilidades (3 moderate, 1 high, 1 critical)** — toda la cadena es dev: `vitest` <3.2.6 (**critical**, GHSA-5xrq-8626-4rwp: Vitest UI permite leer y ejecutar archivos arbitrarios), `vite` ≤6.4.2 (**high**, path traversal GHSA-4w7w-66w2-5vf9 + 2 más), `esbuild` ≤0.24.2 anidado bajo `tsx`/`vite` (moderate, dev server), `vite-node`, `@vitest/mocker`.
- **Lockfile**: v3, 264 deps externas, **100% con `integrity` sha512 y `resolved` apuntando a `registry.npmjs.org`**, sin overrides, `name/version` consistente (vergis 0.2.2). Íntegro.
- **`npm outdated`**: `vitest` 2.1.9 → 4.1.10, `esbuild` 0.25.12 → 0.28.1, `tedious` 19.2.1 → 19.2.2 (wanted), `mssql` 12.5.4 → 12.7.0 (wanted), `typescript` 6.0.3 y `@types/node` 26 disponibles (no urgentes en Node 22).

## Hallazgos, por severidad

### SEV alta

1. **[alta] · Docker/secretos · `Dockerfile:7` + `.dockerignore`** — El stage de build hace `COPY . .` y el `.dockerignore` (9 líneas: `node_modules`, `dist`, `*.log.jsonl`, `out`, `.git`, `.DS_Store`…) **no excluye `.env`**. El flujo documentado en `docker-compose.yml:5` es `cp .env.example .env` en el mismo directorio donde se corre `docker compose build`: cuando `.env` exista (en la VM o en dev), el secreto del Service Principal de Fabric (`VERGIS_CONNECTIONS` con `clientSecret`) queda **horneado en la capa del stage de build y en el caché de buildx**. Hoy `.env` no existe en este working dir, pero el diseño lo garantiza en despliegue. *Mejora*: añadir `.env` y `.env.*` a `.dockerignore` (y de paso `docs/`, `tests/`, `.github/`, `local/` para achicar contexto). **Esfuerzo S** — es la corrección de mayor retorno de toda la revisión.

2. **[alta] · Operación/red · `docker-compose.yml:14-15`** — `ports: "8080:8080"` publica en `0.0.0.0`. Detrás de Caddy+oauth2-proxy eso significa que **el puerto 8080 esquiva el proxy de autenticación**, y Docker inserta reglas iptables que puentean ufw/firewalld en la VM. El gate básico `VERGIS_USER/PASS` es opcional y vacío por defecto. *Mejora*: `ports: "127.0.0.1:8080:8080"` (Caddy accede por loopback o red interna de compose). **Esfuerzo S**.

### SEV media

3. **[media] · Supply chain/CI · `.github/workflows/build.yml:19,20,35-51`** — Todas las actions van **pinneadas por tag mutable** (`actions/checkout@v4`, `setup-node@v4`, `docker/login-action@v3`, `build-push-action@v6`, `metadata-action@v5`, etc.), no por SHA. El precedente `tj-actions/changed-files` (marzo 2025) mostró exactamente ese vector; `docker/login-action` además maneja el `GITHUB_TOKEN` con `packages:write`. *Mejora*: pinnear por SHA de commit con comentario del tag, y dejar que Renovate los actualice (`extends: ["helpers:pinGitHubActionDigests"]`). **Esfuerzo S**.

4. **[media] · Supply chain/toolchain dev · `package.json:24` (`vitest ^2.1.8`)** — El **critical** del audit completo vive en el runner de tests que ejecuta código en cada `npm test` local y en CI. El riesgo real es moderado (los advisories aplican al dev server / Vitest UI, que no usan), pero es un critical parado en la cadena que sí se ejecuta. *Mejora*: subir a `vitest ^3.2.6` (o v4); la migración v2→v3 es menor para una config tan simple como `vitest.config.ts`. Eso arrastra vite/vite-node/mocker y deja el audit completo en verde. **Esfuerzo M**.

5. **[media] · Docker · `Dockerfile:5,10`** — Imagen base `node:22-slim` por **tag mutable, sin digest**. El mismo tag cambia de contenido silenciosamente entre builds (y entre las dos etapas podría incluso resolver distinto en runners distintos). *Mejora*: `FROM node:22-slim@sha256:...` en ambos stages y `extends: ["docker:pinDigests"]` en `renovate.json` para que el pin se mantenga solo. **Esfuerzo S**.

6. **[media] · Docker/operación · `Dockerfile` y `docker-compose.yml` — sin `HEALTHCHECK`** — El server expone `/healthz` con semántica de readiness bien hecha (`server/serve-rls.ts:533` responde 503 hasta `ready`), pero **nadie lo consume**: ni `HEALTHCHECK` en la imagen ni `healthcheck:` en compose. `restart: unless-stopped` solo reinicia si el proceso muere; un contenedor colgado o eternamente en 503 queda "up". *Mejora* (en compose; `node:22-slim` no trae curl): `test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`. **Esfuerzo S**.

7. **[media] · CI · `build.yml:11-13`** — `permissions` a nivel **workflow** concede `packages: write` también al job `test` (que corre en PRs y no publica nada). Mínimo privilegio pide moverlo: workflow-level `contents: read`, y `packages: write` solo en el job `image`. Además **no hay `concurrency`**: pushes seguidos a la misma rama acumulan runs (y builds multi-arch de ~minutos). *Mejora*: permisos por job + `concurrency: { group: build-${{ github.ref }}, cancel-in-progress: true }` (con cuidado de no cancelar el publish de tags). **Esfuerzo S**.

8. **[media] · Operación · `docker-compose.yml` — sin límites de recursos ni rotación de logs** — El driver por defecto `json-file` **sin `max-size` crece sin tope** (en una VM chica eso termina llenando el disco), y no hay `mem_limit`/`cpus` (el render de dashboards con vega puede ser memoria-intensivo). *Mejora*: `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }` + `mem_limit` acorde a la VM. **Esfuerzo S**.

### SEV baja

9. **[baja] · Docker/caché · `Dockerfile:7-8`** — En el stage de build, `COPY . .` va **antes** de `npm ci`, así que cualquier cambio de código invalida la capa de instalación de deps (el stage final sí lo hace bien con manifests-first en líneas 17-23). *Mejora*: replicar el patrón manifests→`npm ci`→`COPY` fuente en el stage de build. **Esfuerzo S**.

10. **[baja] · Operación/señales · `server/serve-rls.ts`** — El único handler de señal es `SIGHUP` (línea 914, hot-reload). No hay handler de `SIGTERM`: con CMD en exec-form node es PID 1 y el default de Node termina el proceso de inmediato, o sea el contenedor **sí para bien**, pero los requests en vuelo se cortan sin drain. Para dashboards de refresh de 5 min es tolerable; si quieren pulcritud: `process.on('SIGTERM', () => server.close(() => process.exit(0)))` con timeout. **Esfuerzo S**.

11. **[baja] · Config TS · `tsconfig.base.json:8`** — `strict: true` + `noImplicitOverride`, pero falta **`noUncheckedIndexedAccess`** (y opcionalmente `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`). El código ya usa el estilo `process.env['X']` que se lleva bien con él; en un motor que indexa filas/columnas dinámicas (`Record<string, unknown>` por todos lados en `serve-rls.ts` y capabilities) es justo la clase de bug que atrapa. Activarlo va a aflorar errores en el codebase. **Esfuerzo M**.

12. **[baja] · CI/calidad · sin lint ni coverage** — No existe config de ESLint ni script `lint` en ningún `package.json`, y `vitest.config.ts` no configura `coverage` (ni threshold ni reporter). El CI corre typecheck+tests+audit+build pero nada de estilo/reglas ni medición de cobertura. Tampoco hay **escaneo de la imagen publicada** (Trivy/Grype) — el SBOM se genera pero nadie lo consume. *Mejora*: `eslint` flat config + `typescript-eslint` con script `lint` en CI; `vitest run --coverage` con `@vitest/coverage-v8`; paso opcional `aquasecurity/trivy-action` sobre la imagen antes del push. **Esfuerzo M**.

13. **[baja] · Versionado · `package.json:4` (0.2.2) vs `CHANGELOG.md` vs rama** — El CHANGELOG declara su propio contrato: «**Y sube con cada conjunto de capacidades nuevas del DSL**». La rama acumula cuatro commits (2026-07-01) con F1–F12, R2-1…R2-7 y **R3-1…R3-8 explícitamente "features del DSL"**, y la versión sigue en 0.2.2 (última entrada del CHANGELOG: 2026-06-11). El pie del inspector mostrará `Mira v0.2.2` para un motor que ya no es 0.2.2. *Mejora*: bump a **0.3** + entrada de CHANGELOG antes del merge a main. **Esfuerzo S**.

14. **[baja] · Higiene · `package.json` sin `engines`** — El build target es `node22` (esbuild) y el CI fija Node 22, pero nada impide un `npm ci` local en Node 18 con fallos crípticos. *Mejora*: `"engines": { "node": ">=22" }`. **Esfuerzo S**.

## Lo que ya está bien resuelto (no requiere acción)

- **Prod deps limpias**: audit `--omit=dev` en 0; superficie de producción mínima (ajv, yaml, sql.js + mssql/tedious/vega en capabilities).
- **Lockfile íntegro**: v3, integrity completa, todo desde registry.npmjs.org, sin overrides colgando.
- **`.npmrc` con `ignore-scripts=true`** documentado (ADR-001) y copiado a la imagen (Dockerfile:17), así el `npm ci` del stage final también corre sin lifecycle scripts.
- **Multi-stage real**: runtime sin tsx, `--omit=dev`, manifests-first en el stage final, `USER node`, CMD en exec-form.
- **CI con gate**: `npm audit --omit=dev --audit-level=high` + typecheck + tests + build, y la imagen se publica con **SBOM + provenance mode=max** y tags semver/sha.
- **Renovate con cooldown** de 14 días + bypass por alertas OSV — mitigación correcta de compromisos de paquetes recientes.
- **Secretos fuera de git**: `.env` en `.gitignore`, `.env.example` sin valores reales; los scripts de `scripts/` no tienen credenciales duras (solo `smoke-secret` y user `botler` de arneses locales, correctamente marcados como no-CI/no-prod).
- **`/healthz` con semántica readiness** bien diseñada (503 hasta bootstrap) — solo falta cablearlo (hallazgo 6).

## Evaluación general

La postura es **notablemente por encima del promedio para un producto en fase 0.x**: las rondas anteriores atacaron lo correcto (lifecycle scripts, imagen precompilada non-root, gate de audit, cooldown de Renovate, SBOM/provenance) y el lockfile está impecable. Los dos huecos que quedan con dientes de verdad son de **borde, no de núcleo**: el `.env` con el secreto del Service Principal entrando al build context (una línea de `.dockerignore` lo cierra) y el 8080 publicado en `0.0.0.0` puenteando el oauth2-proxy y el firewall de la VM. Cerrados esos dos más el pin por SHA de las actions y el digest de la imagen base, el repo queda con una cadena de suministro que resiste los vectores que de verdad ocurren (tag hijacking, paquete comprometido, secreto horneado); el resto es pulitura operacional (healthcheck, logs, límites) y deuda de calidad menor (lint/coverage/vitest 3). Chévere el trabajo previo — lo que falta es corto y barato.

---

• *Generado con [Wingworking](https://wingworking.org)*
