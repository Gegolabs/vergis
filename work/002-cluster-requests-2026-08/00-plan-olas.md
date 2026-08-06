# 002 · Cluster — Atención de requests abiertos (2026-08-06)

Sesión autónoma: atender los 15 issues accionables abiertos en Gegolabs/vergis.
Modelo de trabajo (ww:wingcoding): **Fable diseña** (un doc por issue en este cluster),
**Opus implementa** (subagente por issue, worktree propio), el orquestador integra
secuencialmente con gates verdes (`npm run typecheck` · `npm test` · `npm run build`)
y merjea a main.

## Olas (por territorio, para paralelizar sin pisarse)

| Ola | Issues | Territorio dominante |
|-----|--------|----------------------|
| A | #99 (log corrida) · #61 (export CSV/Excel) · #117 (fail-closed config) · #66 (CredentialProvider) | observabilidad · render tablas · carga de config · auth |
| B | #101 (estado en Fuentes) · #114 (chips filtros) · #62 (dedup hash) · #108 (as-of header) | admin/sources · render interactivo · intake · render header |
| C | #105 (proyección ingestion_run) · #63 (revertir carga) · #109 (options_ref) · #65 (PDF) | frescura · intake/ledger · intake/meta · render+compose |
| D | #100 (aviso desacoplado) · #102 (reporte email) · #107 (gestión por rol) | monitor/notificación · canales salida · admin+roles |

Dependencias: #101←#99 · #63←#62 · #102←{#99,#101,#100} · #100←#105 (proyección) [soft].

Fuera de alcance de la sesión: #113/#110 (épicas sombrilla), #111 (diferido explícito),
#106 (docs — se atiende solo si sobra el tren), deploy a la VM (gated, hand-off).

## Diseños

Cada issue tiene su doc `diseno-ghNN.md` en este directorio — es el contrato de
delegación que ejecuta el Opus (autocontenido, decisiones selladas, territorio,
«hecho cuando» por tarea, juez declarado).
