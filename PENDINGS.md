# PENDINGS — detectados por el agente

Pendientes que **detectó el agente**, no encargó el humano. TTL 15 días desde `reg`: al vencer
pasan a `ROTTEN.md`. Lo que César declare o confirme como pendiente vive en `TODO.md` (sin TTL);
la promoción PENDINGS→TODO se pide, no se toma.

## Operación / despliegue

- **`VERGIS_CSRF_SECRET` no definido en PROD ni en QA** — el server genera uno aleatorio al arrancar
  y lo avisa: los formularios de gestión abiertos no sobreviven un restart ni se comparten entre
  réplicas. Fijarlo en `vergis.env` de cada VM. `reg 2026-08-06`
- **QA: 403 del service principal al observar 2 items del motor** (`ingest_finanzas_saldos`,
  `ingest_personas_asistencia`) — el lazo de frescura degrada como fue diseñado (registra y sigue),
  pero el entorno QA queda sin observabilidad real de esos procesos. Permisos del SP en el
  workspace de QA. No es regresión de 0.14.0. `reg 2026-08-06`

## Espera decisión de César

- **Diseño 003·C (issue #138 pieza 2): env → archivo recargable** — diseño listo en
  `work/003-cluster-solicitudes-2026-08-07/03-diseno-env-recargable-v1.0.md` con tres decisiones
  que le tocan a César (precedencia archivo-vs-env en tunables, re-siembra vs gestionado in-app,
  alcance de fases). No se implementa sin su OK. `reg 2026-08-07`

## Código / CI

- **`actions/checkout@v4` y `actions/setup-node@v4` avisan deprecación de Node 20** en cada corrida
  del workflow `build`. Subir a v5 cuando toque. `reg 2026-08-06`
- **Header del theme `default`: el título quedó como marca enlazada** (desviación declarada de #136 —
  ese theme no tiene logo). Es un elemento visible nuevo, no solo un wrapper; merece ojo humano.
  La instancia A.R.B.O.L. usa el theme `arbol`, así que no la afecta. `reg 2026-08-06`
- **Gramática de nombre de archivo duplicada** entre `vtCsvName` (#61) y `pdfFilename` (#65) —
  misma convención `slug--fecha[--filtrado]` implementada dos veces. Unificar. `reg 2026-08-06`
- **`import type { TableColumn }` sin uso** en `render-csv-piece.ts` (preexistente a #61, no
  introducido por él). `reg 2026-08-06`
- **`VERGIS_VERSION` no está re-exportado por el índice de `@vergis/capabilities`** — `server/contract.ts`
  lo importa por ruta relativa a `packages/capabilities/src/version` (funciona y evita arrastrar
  vega/mssql a los tests unitarios, pero cruza la frontera del package). Decidir: re-export en el
  índice o bendecir el import directo a módulos-hoja. `reg 2026-08-07`
