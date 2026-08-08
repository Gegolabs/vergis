# 005 · Plan del cluster — ejecución de los atendibles del backlog (2026-08-08)

**Mandato de César** (sesión 2026-08-08): ejecutar por subagentes, en este orden de prioridad, lo
atendible hoy del tablero del repo: **(1)** el fix de pertenencia de sesiones de Miranda —brecha de
seguridad viva en `main`, ampliada por la re-revisión Fable de 2 a 5 rutas—, **(2)** el hito H0 de
canales (#113), **(3)** el N2 del contrato operativo (#139) y el preview RLS con dos identidades
(#110·1). Fable diseña y orquesta; Opus implementa en worktrees (`ww:wingcoding` Regla 2).

## Fuentes de verdad y precedencia

Cada frente tiene UN documento de diseño que manda. Precedencia dentro de cada frente:
**(1)** el diseño del frente → **(2)** este plan (deltas y brief) → **(3)** los issues (contexto).
**Si el código contradice un anclaje `archivo:línea` del diseño, manda el código: adapta el
anclaje, no el diseño.** Las anclas de los diseños de 004 son del árbol al commit `6cc0bd7`; las de
005·01, de `be55600`.

| Frente | Diseño que manda | Deltas de este plan sobre el diseño |
|---|---|---|
| **F1 · Pertenencia Miranda** | `work/005-cluster-ejecucion-atendibles-2026-08-08/01-diseno-pertenencia-sesiones-miranda-v1.0.md` | Ninguno — nació completo en este cluster |
| **F2 · H0 canales (#113)** | `work/004-cluster-disenos-backlog-2026-08-07/08-113-canales-salida-v1.0.md`, **solo §4·H0** (+§1.4 como contexto) | Δ1 (seam testeable, abajo) |
| **F3 · N2 contrato (#139)** | `work/004-cluster-disenos-backlog-2026-08-07/01-139-n2-delta-contrato-v1.0.md`, completo (H1+H2+H3) | Ninguno |
| **F4 · Preview RLS (#110·1)** | `work/004-cluster-disenos-backlog-2026-08-07/06-110-miranda-post-f1-v1.0.md`, **solo Pieza 1** | Δ2, Δ3, Δ4 (abajo) |

### Deltas sellados (correcciones de la sesión sobre los diseños de 004)

- **Δ1 (F2) — el «hecho cuando» de H0 exige un seam observable.** `MIRANDA_VALIDATE_CAPS` es un
  const local de `serve-rls.ts` (módulo con top-level `await`, no importable en tests). Para que el
  test de H0 pueda observar la lista real: extraerla a un builder puro **exportado desde
  `server/miranda.ts`** — `export const mirandaValidateCaps = (servingCaps: Iterable<string>): string[] =>
  [...servingCaps, 'publicar-artefacto', 'render-html-piece', 'render-csv-piece']` — y que
  `serve-rls.ts:1467` lo consuma. El test entonces demuestra las DOS cosas: la lista ya no promete
  `send-email`/`send-slack`, y `validateMiraSpec` con esa lista rechaza un spec con canal
  `send-email` con código `channel-capability-not-catalogued` (`packages/mira/src/dsl/validate.ts:401`)
  — el experimento que refuta (o confirma) la cadena de §1.4 del diseño. Esto además deja pagado el
  primer paso de D6 del propio diseño (la lista deja de estar escrita a mano en el server).
- **Δ2 (F4) — el check de pertenencia del hito 2 de la Pieza 1 (D3) YA lo implementa F1.** F4 nace
  de `main` con F1 integrado: no re-implementa pertenencia; la asume y construye encima
  (`requireSession` ya existe — úsalo).
- **Δ3 (F4) — la auditoría D4 necesita un seam que el diseño no cablea:** el `AppendOnlyLog` de
  auditoría vive en `serve-rls.ts` (`admin-audit.log`, ~línea 922). Añadir a `MirandaServerDeps` el
  dep `audit?: (event: Record<string, unknown>) => void`, cableado a `auditLog.append`; el evento es
  el `miranda-preview-as {session, actor, as}` que D4 declara.
- **Δ4 (F4) — errata conocida del doc 06:** su pie decía anclas «al commit 4d2e622»; son del árbol
  `6cc0bd7`/HEAD (errata ya corregida en el doc). Re-verificar anclas contra el árbol actual igual
  (Norma 6 del propio doc, riesgo «Transversal»).

## Frentes, olas y territorios

**Regla de paralelismo:** solo corren juntos frentes de territorio disjunto. La integración es
SIEMPRE secuencial, un frente a la vez sobre `main` (la hace el orquestador, no los ejecutores).

### Ola 1 — en paralelo: F1 ∥ F3

| | F1 · Pertenencia | F3 · N2 contrato |
|---|---|---|
| Rama | `fix/miranda-pertenencia-sesiones` | `feat/139-n2-delta-contrato` |
| Territorio | `server/miranda.ts` · `server/serve-rls.ts` (SOLO el objeto de deps Miranda, +1 línea `isAdmin`, ~:1484) · `tests/miranda-ownership.test.ts` (nuevo) | `server/contract-delta.ts` (nuevo) · `server/contract.ts` · `server/serve-rls.ts` (SOLO: creación del journal junto a `createContractRegistry` ~:168, `observe` tras el record de boot ~:1694, y el getter del handler ~:703-707) · `tests/contract-delta.test.ts` (nuevo) · `tests/contract.test.ts` (extender) · `README.md` (H3) |
| Disjunción | Ambos tocan `serve-rls.ts` en regiones distantes (bloque Miranda ~1480 vs tres puntos ≤1694); cero archivos de test compartidos. Conflicto esperado: ninguno; si el merge de integración los cruza, resuelve el orquestador | — |

### Ola 2 — tras integrar la Ola 1: F2, luego F4 (secuencial entre sí)

| | F2 · H0 canales | F4 · Preview RLS |
|---|---|---|
| Rama | `fix/113-h0-caps-prometidas` | `feat/110-preview-rls-identidades` |
| Territorio | `server/serve-rls.ts:1467` (consumir el builder) · `server/miranda.ts` (export del builder Δ1) · `tests/miranda-validate-caps.test.ts` (nuevo) | `server/config.ts` (campo+parseo roster) · `server/serve-rls.ts` (bloque Miranda: deps `previewIdentities`/`renderPreviewHtmlAs`/`audit`) · `server/miranda.ts` (rutas `?as=`/compare, UI, D4) · `packages/miranda/src/tools/*` (tool ampliada) · tests según el diseño |
| Orden | **F2 se ejecuta e integra ANTES de F4** — ambos tocan el bloque Miranda de los dos mismos archivos; F2 es ~1 hora y F4 nace de `main` ya con F2 dentro | — |

**Dependencias:** F4 requiere F1 integrado (Δ2) y arranca tras integrar F2. F2 y F3 no dependen de
nadie. **Cruce de territorio verificado contra las tareas de cada diseño: toda tarea cae dentro del
territorio de su frente.**

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

Secuencial, por frente: **F1 → F3 → F2 → F4** (F3 puede integrar antes que F1 si termina primero —
son disjuntos; F2 y F4 esperan su ola).

1. Revisar el reporte contra los gates y el diseño; divergencias con juicio propio (una bien
   razonada puede estar corrigiendo el diseño — se acepta y se registra; una mal razonada se
   devuelve). Cruzar los reportes entre sí: lo que ningún frente vio solo.
2. Si `main` avanzó: merge de `main` a la rama y **re-correr los tres gates sobre la combinación**.
3. **`git diff --stat` antes de sellar: un `Bin` en archivo de texto es corrupción W-02** — se
   corrige a nivel de bytes (`perl -pi -e`), jamás re-emitiendo la secuencia.
4. PR por frente con cuerpo que cite el diseño y pegue la salida de los gates; merge; **verificar
   el CI del push a main antes de integrar el siguiente frente**.
5. Al cerrar la tanda: comentar en los issues (#113 tras F2, #139 tras F3, #110 tras F1+F4) con la
   disciplina de Normas 6/7 — lo medido como medido, lo inferido etiquetado. **Jamás cerrar los
   issues** (el cierre es del autor). El comentario de F3 debe declarar la expectativa D6 del
   diseño: el primer despliegue con N2 solo siembra el journal; el delta aparece desde el segundo.
6. Registro: fila de bitácora con hora medida (`date`), `DECISIONS.md` al momento de cada decisión
   delegada, `PENDINGS.md` para lo que nazca, re-derivar el tablero del repo antes de dar el Listo.

## ¿Qué NO entra en este cluster?

- Nada que espere decisión de César: los 5 bloques de `PENDINGS.md` §«Espera decisión» (004/03,
  004/11, 004/04, 004/08 D1/migración, 004/10 D8) siguen esperando.
- Deploy a producción (Norma 5) — lo integrado queda en `main` con imagen verde; el hand-off de
  deploy ya está registrado en `PENDINGS.md`.
- El corte de `CHANGELOG.md` (decisión de César, precedente D-05).
- Los demás hitos de los diseños citados (H1-H4 de canales, N3, piezas 2-5 de #110).

---
• 🤖 Claude (Fable) · plan del cluster 005 · 2026-08-08
