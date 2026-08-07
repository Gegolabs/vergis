# 003 · Plan del cluster — solicitudes #138 y #139 (2026-08-07)

**Origen:** issues [#138](https://github.com/Gegolabs/vergis/issues/138) y [#139](https://github.com/Gegolabs/vergis/issues/139), abiertos por César el 2026-08-07 desde el incidente de la instancia A.R.B.O.L. (reinicio innecesario que cortó los 8 PIs 1,1 s).

## Frentes

| Frente | Alcance | Documento | ¿Se implementa en esta sesión? |
|---|---|---|---|
| **A** | #139 Nivel 1 — contrato operativo consultable (`/contrato`) | `01-diseno-contrato-operativo-v1.0.md` | Sí — subagente Opus, worktree |
| **B** | #138 pieza 3 — medición del arranque en frío + paralelizar el par de queries por conexión | `02-medicion-arranque-frio-v1.0.md` | Sí — subagente Opus, worktree |
| **C** | #138 pieza 2 — config de arranque → vía recargable | `03-diseno-env-recargable-v1.0.md` | **No** — diseño para revisión de César (toca el contrato de despliegue de las instancias) |

Fuera de alcance de la sesión: #139 Niveles 2 (delta entre versiones) y 3 (Miranda encima) — el issue los declara no-indispensables.

## Orden e integración

A y B corren en paralelo (worktrees propios; territorios disjuntos salvo regiones distintas de `serve-rls.ts`). Integración **secuencial**: B primero (cambio chico), A rebasa. Gates por integración: `npm run typecheck` · `npm test` · `npm run build`, serializados en main.

## Juez

Suite hermética + typecheck + build en main tras cada merge. El despliegue a PROD **no** es de esta sesión (requiere autorización explícita — Ley de Wingworking, Norma 5).

---
• 🤖 Claude (Fable) · cluster 003
