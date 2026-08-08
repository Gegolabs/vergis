# PENDINGS-done — derivado frío de `PENDINGS.md`

Partidas detectadas por el agente que ya cerraron, con la evidencia del cierre. Las que vencieron
su TTL de 15 días **sin veredicto** viven en la sección «Vencidas sin veredicto» — vencer no es
cerrar.

## Cerradas con veredicto

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
