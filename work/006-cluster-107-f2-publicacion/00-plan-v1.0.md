# 006 · Plan del cluster — fase 2 de #107: publicación de jobs (H1→H5)

**Mandato de César** (sesión 2026-08-08): construir la fase 2 COMPLETA de #107 —«seguir con la fase
hasta el final»— tras el veredicto positivo del hito cero (el SP puede autorar items; sellado como
comentario en #107 con los crudos de dos corridas). Fable diseña y orquesta; Opus implementa en
worktrees (`ww:wingcoding` Regla 2, Ley Norma 8).

## Fuente de verdad y precedencia

**El diseño que manda:** `work/004-cluster-disenos-backlog-2026-08-07/04-107-f2-publicacion-jobs-v1.0.md`
— §4 (modelo), §5 (arquitectura y contratos), §6 (plan H1-H5). Decisiones D1-D12 todas aprobadas.
Precedencia: **(1)** el diseño → **(2)** este plan (deltas) → **(3)** el issue #107 (contexto y
crudos del hito cero). **Si el código contradice un anclaje `archivo:línea` del diseño, manda el
código: adapta el anclaje, no el diseño — y repórtalo como divergencia.** Las anclas del diseño son
del árbol `6cc0bd7`; el árbol actual es `44e5a16` — re-verificar cada ancla antes de usarla.

**El oráculo medido:** `scripts/probe-item-authoring.ts` corrió dos veces contra el tenant. Sus URLs,
su manejo de LRO (`pollLro`, `operationIdOf`), su extracción de `errorCode` (`errorCodeOf`) y sus
resultados son **hechos medidos**, no conjetura. H1 copia esa semántica; no re-adivina la API.

## Deltas sellados (los del destranque, sobre el diseño de 004)

- **Δ1 — D7 canonicaliza (hallazgo MEDIDO del hito cero).** El motor normaliza el payload al
  persistir: `""` → `null` y re-serialización pretty-print con CRLF (crudos en #107). Comparar por
  sha de bytes crudos marcaría «no confiable» toda publicación legítima. Nace el módulo
  **`packages/capabilities/src/definition-canonical.ts`** (territorio de H2) con la forma canónica:
  por cada part, decodificar base64 → UTF-8; si `JSON.parse` da, normalizar profundo (`""` → `null`
  en valores string, claves de objeto ordenadas) y re-serializar compacto (sin whitespace, LF); si
  no parsea, el payload queda byte-a-byte (no se inventa normalización no medida — conjetura
  etiquetada en el código). Sha canónico: sha256 hex sobre las parts **ordenadas por path**,
  concatenando `path + '\n' + payloadCanónico + '\n'`. Exporta `canonicalDefinitionSha256(parts)` y
  `definitionsEquivalent(a, b)` (igualdad de shas canónicos). **El sha del render (H2), el del
  ledger (H3) y el del read-back (H4) son TODOS el canónico** — una sola identidad.
- **Δ2 — `derivePublishPlan` es puro sobre shas.** No hace red ni canonicaliza: recibe
  `renderedSha`, `engineSha: string | null` (null = el item no existe) y el último sha `ok` del
  ledger, y decide create/update + drift + hash del plan. Quien llama a `getDefinition` y
  canonicaliza es el flujo admin (H4). Así H3 no depende de H1 ni de H2 en la Ola 1.
- **Δ3 — Los tipos no cruzan frentes en la Ola 1.** `DefinitionPart`/`ItemDefinition` los declara
  H1 (`fabric-authoring.ts`, §5 del diseño). H2 usa un tipo estructural local compatible
  (`{ path: string; payloadBase64: string }`) sin importar de H1. Desde H4 (Ola 2, todo integrado)
  se importa de H1 con normalidad.
- **Δ4 — `index.ts` es cruce declarado.** H1, H2 y H3 agregan cada uno sus líneas `export` al barrel
  `packages/capabilities/src/index.ts`. Conflicto esperado y trivial: lo resuelve el orquestador en
  la integración. Ningún frente toca los exports de otro.
- **Δ5 — `VERGIS_JOB_TEMPLATES` nace SOLO-ARRANQUE.** No entra en `RELOADABLE_SLICES`
  (`server/instance-config.ts:87-95`): las fases 2-3 de #138·2 esperan decisión de César con sus
  disparadores. Carga por el molde `loadOne` (fail-closed, fatal). Las rutas de las parts del
  manifiesto se resuelven **relativas al directorio del manifiesto**, leídas por el seam `ReadFile`.
- **Δ6 — Hechos medidos que H1 incorpora:** `POST /items` responde **201 directo** (no LRO) para
  SJD — el cliente maneja ambos caminos (201 directo y 202+LRO con `Retry-After`, tope 120 s); el
  nombre de part `SparkJobDefinitionV1.json` está confirmado por el motor; el read-back llega por
  `POST …/getDefinition` (200 directo o 202+LRO). El motor puede **agregar parts propias** al
  read-back (p. ej. `.platform`) — la comparación canónica de H4 compara solo las parts publicadas.
- **Δ7 — H4 y el cyber-safeguard.** La revisión automatizada de `server/admin.ts` la corta el
  safeguard (memoria `cyber-safeguard-admin-ts`): la revisión del orquestador sobre H4 es manual
  (checklist contra el diseño §4-5), no vía herramienta de review.

## Hitos, olas y territorios

**Regla de paralelismo:** solo corren juntos frentes de territorio disjunto. Integración SIEMPRE
secuencial sobre `main`, un frente a la vez, por el orquestador.

### Ola 1 — en paralelo: H1 ∥ H2 ∥ H3

| | H1 · Capability de autoría | H2 · Plantillas | H3 · Ledger y plan |
|---|---|---|---|
| Rama | `feat/107-h1-fabric-authoring` | `feat/107-h2-job-templates` | `feat/107-h3-job-publication` |
| Territorio | `packages/capabilities/src/fabric-authoring.ts` (nuevo) · `index.ts` (solo sus exports) · `tests/fabric-authoring.test.ts` (nuevo) | `packages/capabilities/src/job-templates.ts` (nuevo) · `packages/capabilities/src/definition-canonical.ts` (nuevo, Δ1) · `index.ts` (solo sus exports) · `tests/job-templates.test.ts` (nuevo) · `tests/definition-canonical.test.ts` (nuevo) · `server/instance-config.ts` (env `VERGIS_JOB_TEMPLATES`, Δ5) · `examples/` (plantilla de muestra) | `packages/capabilities/src/job-publication.ts` (nuevo) · `index.ts` (solo sus exports) · `tests/job-publication.test.ts` (nuevo) · `packages/capabilities/src/governance-store.ts` (SOLO el DDL de `job_publication` en `open`) |
| Diseño | §5 (contrato `ItemAuthoringClient`), §6·H1 · Δ3, Δ6 | §4 (plantillas, render), §6·H2 · Δ1, Δ3, Δ5 | §4 (ledger, drift), §6·H3 · Δ2 |
| Disjunción | El único cruce entre los tres es `index.ts` (Δ4). H2 toca `server/instance-config.ts` y H3 `governance-store.ts` — nadie más los toca. | | |

### Ola 2 — tras integrar la Ola 1: H4 · Flujo admin

Rama `feat/107-h4-admin-publish`. Territorio: `server/admin.ts` (sección «Publicación de jobs» en
`/admin/sources`, rutas `publish-plan`/`publish-exec`) · `tests/admin-jobs-publish.test.ts` (nuevo,
arnés calcado de `tests/admin-sources.test.ts`). Diseño §4 (roles, fail-closed, audit), §5, §6·H4;
patrón dos fases con hash sellado de `server/admin-cargas.ts` (revert-plan/revert-exec). El
read-back D7 compara con `canonicalDefinitionSha256` (Δ1); el plan se deriva con `derivePublishPlan`
alimentado por `getDefinition` + canonicalización (Δ2).

### Ola 3 — al final: H5 · Wiring + documentación

Rama `feat/107-h5-wiring-docs`. Territorio: `server/serve-rls.ts` (construcción condicional del
publisher e inyección a `createAdmin`) · `docs/gestion-de-dominio.md` (sección «Publicar el job de
un proceso») · `docs/frescura-oferta-demanda.md` (párrafo create→observar). Diseño §5 (wiring),
§6·H5. Gate extra: `npm run build`.

**Dependencias:** H4 exige H1+H2+H3 integrados en `main`. H5 exige H4. Dentro de la Ola 1 no hay
dependencias.

## Brief común de los ejecutores (va VERBATIM en cada delegación, más el brief del frente)

1. **Modelo y rol.** Eres un ejecutor Opus. Tu fuente de verdad es el documento de diseño de tu
   frente (ruta exacta en tu brief); este plan aporta los deltas. Si el código contradice un
   anclaje, manda el código: adapta el anclaje, no el diseño — y repórtalo como divergencia.
2. **Entorno (mañas que no puedes adivinar).** El estado de shell NO persiste entre comandos:
   antepón `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` a TODO comando que use node/npm/npx
   (node es keg-only, no está en el PATH por defecto). Trabajas en un worktree git propio: antes de
   los gates corre `npm ci` una vez (el worktree nace sin `node_modules`; `.npmrc` ya trae
   `ignore-scripts`).
3. **Gates (el juez), sin pipes que enmascaren exit codes, cada uno en su propio comando:**
   `npm run typecheck` · `npm test` · `npm run build`. No existe script `lint` — no lo inventes.
4. **Prohibiciones duras:** no push, no PR, no editar `INDEX.md`, no tocar `main`, no editar tests
   existentes (un test viejo en rojo se REPORTA, no se arregla), no `git config`. Todo comando
   destructivo (`rm`, `pkill`, limpiezas) acotado a TU worktree por ruta explícita — y verifica que
   el patrón de verdad matchea antes de confiar en él.
5. **Norma 6/7:** toda afirmación de tu reporte se verifica antes de escribirla o se etiqueta
   conjetura. Si tu frente incluye un experimento que puede refutar una premisa del diseño y la
   refuta, **reportar la refutación ES el resultado válido** — no fuerces el diseño contra el código.
6. **Commit:** commits atómicos en tu rama, mensajes en español estilo del repo
   (`fix(...)`/`feat(...)`), sin `Closes #N`.
7. **Formato del reporte final:** archivos cambiados (lista) · salida REAL de los tres gates
   (últimas líneas, con exit code) · números medidos (tests antes/después) · rama y hash final ·
   divergencias con el diseño y su porqué · conjeturas etiquetadas.

## Integración (el orquestador; no delega su juicio)

Secuencial, por hito: H1 → H2 → H3 (en el orden en que terminen; son disjuntos) → H4 → H5.

1. Revisar el reporte contra los gates y el diseño; divergencias con juicio propio. Cruzar los
   reportes de la Ola 1 entre sí: los shas y tipos deben calzar en H4 (Δ1-Δ3).
2. Si `main` avanzó: merge de `main` a la rama y **re-correr los tres gates sobre la combinación**.
   En la Ola 1 el conflicto esperado es `index.ts` (Δ4) — lo resuelve el orquestador.
3. **`git diff --stat` antes de sellar: un `Bin` en archivo de texto es corrupción W-02** — se
   corrige a nivel de bytes (`perl -pi -e`), jamás re-emitiendo la secuencia.
4. PR por hito con cuerpo que cite el diseño y pegue la salida de los gates; merge; **verificar el
   CI del push a main antes de integrar el siguiente**.
5. Al cerrar la tanda: comentario en #107 (H1-H5 construidos, con números; **sin cerrar el issue**
   — el cierre es de César), bitácora con hora `date`, `DECISIONS.md` por cada decisión delegada
   (Δ1-Δ5 nacen de este plan), `PENDINGS.md` para lo que nazca, re-derivar el tablero del repo.

## ¿Qué NO entra en este cluster?

- Deploy a la VM (Norma 5) — lo construido queda en `main` con CI verde; el hand-off de deploy
  espera autorización de César (runbook `mira-ops`).
- Recargabilidad de `VERGIS_JOB_TEMPLATES` (fases 2-3 de #138·2 — Δ5) · corte de CHANGELOG · marca
  (D6 open-core) · revisión legal de CONTRIBUTING · todo lo listado como «espera a César».
- Borrar items del motor (D8) · editor in-app de plantillas (D3) · publicación por stewards (D4) —
  no-metas del diseño §8.

---
• 🤖 Claude (Fable) · plan del cluster 006 · 2026-08-08
