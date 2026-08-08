# PENDINGS-done — derivado frío de `PENDINGS.md`

Partidas detectadas por el agente que ya cerraron, con la evidencia del cierre. Las que vencieron
su TTL de 15 días **sin veredicto** viven en la sección «Vencidas sin veredicto» — vencer no es
cerrar.

## Cerradas con veredicto

- **`Dockerfile` omitía el manifiesto de `packages/miranda`** (reg 2026-08-07).
  **Cerrado 2026-08-08:** COPY añadido a ambos stages — PR #149. El experimento del build
  (`docker build` exit 0, daemon real) decidió corrección sobre omisión documentada, como mandaba
  la pieza 5 del H1 de open-core.
- **Cluster 004: los diseños esperaban las decisiones de César** (reg 2026-08-07).
  **Cerrado 2026-08-08:** César resolvió las 14 en sesión guiada — 13 aprobadas tal como estaban
  selladas (03/D1-D2-D3 · 04/D8-D9-D12 con sonda a workspace real · 05/D5 · 08/D1+cap25 ·
  10/D8 a+b+c · 11/D1-D2-D3-D4-D5) y 1 diferida (11/D6 marca → `TODO.md`). Los marcadores de los
  docs quedaron sellados `[aprobada por César · 2026-08-08]`.
- **Miranda: CINCO rutas sin check de pertenencia de sesión** (reg 2026-08-07 como 2 rutas,
  ampliado 2026-08-08 a 5 por re-revisión: `sessionPage` exponía el transcript completo y
  `publish` permitía publicar el draft ajeno; la lista filtraba por dueño — ilusión de privacidad).
  **Cerrado 2026-08-08:** guard `dueño-o-admin` central en las 5 rutas — PR #142 mergeado
  (`dbbc4ba`), +24 tests con experimento de refutación. Diseño `work/005-…/01-…`; semántica D-08.
- **`MIRANDA_VALIDATE_CAPS` prometía `send-email`/`send-slack` inexistentes** (reg 2026-08-07).
  **Cerrado 2026-08-08:** hito H0 de #113 — PR #144 mergeado (`e799b7a`); la lista vive en el
  builder puro `mirandaValidateCaps` y el experimento confirmó el rechazo
  `channel-capability-not-catalogued` con caso de control. Cero apariciones en `server/`.
- **`TODO.md:16` rancio** — declaraba «HMAC + época de 4h» en `server/annotations.ts`, archivo
  retirado con la capa de notas (vergis#84); el único `createHmac` vigente es el CSRF de
  `server/ui.ts:136`, sin época.
  **Cerrado 2026-08-07:** la nota de egreso quedó escrita en `TODO.md:16` (el registro ya no miente).
  La pieza viva que quedaba —rediseñar la época del CSRF— no es un pendiente suelto: vive como
  hito H4 del diseño `work/004-cluster-disenos-backlog-2026-08-07/10-113-hardening-v1.0.md`.
  `reg 2026-08-07 · cerrado 2026-08-07`

## Vencidas sin veredicto

*(ninguna todavía — el TTL más antiguo vigente es del 2026-08-06)*

---
• *Generado con [Wingworking](https://wingworking.org)*
